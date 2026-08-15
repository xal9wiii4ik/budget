"""Provider fetch seam for FX rates (architecture D1/D3).

Stateless and Settings-only: imports **no** ``models`` and touches **no** database
(D13 layering — the storage.py / receipt_parser.py precedent). One ``FxRateFetcher``
is constructed per app onto ``app.state.fx_fetcher`` and the pytest layer swaps a
fake at that seam, so no test ever makes a live provider call. The DB-writing
orchestration lives in ``services/fx_jobs.py``.

Provider decomposition (D1) — each pair has exactly ONE canonical derivation:

===========  ============  =========================================
Pair         Source        Derivation
===========  ============  =========================================
EUR->USD     frankfurter   direct (ECB reference rate)
BYN->USD     NBRB          ``1 / b(USD)``
BYN->EUR     NBRB          ``1 / b(EUR)``
BYN->RUB     NBRB          ``1 / b(RUB)``
RUB->USD     NBRB          ``b(RUB) / b(USD)``  (cross via BYN)
RUB->EUR     NBRB          ``b(RUB) / b(EUR)``  (cross via BYN)
===========  ============  =========================================

where ``b(X) = Cur_OfficialRate / Cur_Scale`` = BYN per ONE unit of X. ``Cur_Scale``
is read from the payload and NEVER assumed to be 1 (RUB is typically quoted per
100). Every stored rate is *quote per one base*, so e.g. BYN->RUB lands around 20-45
(roubles per rouble-ish BYN) while the intermediate ``b(RUB)`` is around 0.02-0.05 —
ignoring ``Cur_Scale`` shows up as a stored BYN->RUB ~100x too small.

All arithmetic runs in the default ``Decimal`` context (28 significant digits);
intermediates are NEVER quantized. Only the final stored rate is quantized to 8 dp
with ``ROUND_HALF_UP`` — one rounding mode for the whole scope (D1/D6).

Failure taxonomy: ``FxFetchError(provider, code)`` with code in
``HTTP_ERROR`` | ``TIMEOUT`` | ``BAD_PAYLOAD``. The job (fx_jobs) catches per
provider and never lets a provider failure escape.
"""

import logging
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, cast

import httpx

from budget_api.config import Settings

logger = logging.getLogger(__name__)

FRANKFURTER = "frankfurter"
NBRB = "nbrb"

#: The three currencies NBRB is asked about; all five NBRB pairs derive from them.
NBRB_CURRENCIES: tuple[str, ...] = ("USD", "EUR", "RUB")

#: Stored precision (D1): 8 dp holds the smallest required rate (RUB->USD ~ 0.011)
#: with sub-basis-point resolution.
_RATE_EXPONENT = Decimal("1E-8")

#: NBRB's ``/exrates/rates/dynamics`` caps one request's period; the fetcher chunks
#: unconditionally so the code is correct whichever way the documented limit reads.
_MAX_WINDOW_DAYS = 365

_ONE = Decimal(1)

# Payload shapes are provider-controlled, so every read is wrapped and any of these
# means "the payload is not what we expect" -> BAD_PAYLOAD (never a crash).
_PAYLOAD_ERRORS = (KeyError, IndexError, TypeError, ValueError, ArithmeticError)


@dataclass(frozen=True)
class FetchedRate:
    """One canonical pair on one date, ready to upsert."""

    base: str
    quote: str
    rate: Decimal
    as_of_date: date
    provider: str


class FxFetchError(Exception):
    """Carries the provider name and one of the taxonomy codes (module docstring)."""

    def __init__(self, provider: str, code: str) -> None:
        self.provider = provider
        self.code = code
        super().__init__(f"{provider}: {code}")


def _finalize(value: Decimal, provider: str) -> Decimal:
    """Quantize the FINAL rate only (8 dp, ROUND_HALF_UP) and reject non-positive.

    A non-positive rate would violate ``ck_exchange_rates_rate_positive`` at insert
    time and poison the whole provider's batch, so it is rejected here as a payload
    problem instead.
    """
    rate = value.quantize(_RATE_EXPONENT, rounding=ROUND_HALF_UP)
    if rate <= 0:
        raise FxFetchError(provider, "BAD_PAYLOAD")
    return rate


def _decimal(raw: Any) -> Decimal:
    # str() first: JSON numbers arrive as float, and Decimal(float) would carry the
    # binary-representation noise into the derivation.
    return Decimal(str(raw))


def _nbrb_doc_date(doc: Mapping[str, Any]) -> date:
    """Effective date of one NBRB document (ISO datetime at midnight).

    Both ``/exrates/rates`` and ``/exrates/rates/dynamics`` documents carry it as
    ``Date``; the NBRB docs also spell it ``Cur_Date`` in places, so both keys are
    accepted — a provider-side naming difference must not turn the whole provider
    into BAD_PAYLOAD. Neither present -> KeyError -> BAD_PAYLOAD at the caller.
    """
    raw = doc.get("Date", doc.get("Cur_Date"))
    if not isinstance(raw, str):
        raise KeyError("Date")
    return datetime.fromisoformat(raw).date()


def derive_nbrb(b: Mapping[str, Decimal], as_of: date) -> list[FetchedRate]:
    """The five NBRB pairs for one date from ``b(USD)/b(EUR)/b(RUB)`` (D1 table).

    ``b`` maps currency code -> BYN per ONE unit of that currency (``Cur_Scale``
    already divided out by the caller).
    """
    usd, eur, rub = b["USD"], b["EUR"], b["RUB"]
    return [
        FetchedRate("BYN", "USD", _finalize(_ONE / usd, NBRB), as_of, NBRB),
        FetchedRate("BYN", "EUR", _finalize(_ONE / eur, NBRB), as_of, NBRB),
        FetchedRate("BYN", "RUB", _finalize(_ONE / rub, NBRB), as_of, NBRB),
        FetchedRate("RUB", "USD", _finalize(rub / usd, NBRB), as_of, NBRB),
        FetchedRate("RUB", "EUR", _finalize(rub / eur, NBRB), as_of, NBRB),
    ]


def parse_nbrb(payloads: Mapping[str, Any]) -> list[FetchedRate]:
    """Latest ``/exrates/rates/{code}?parammode=2`` documents -> the five pairs.

    ``payloads`` maps currency code -> that currency's document. The as-of date is
    the EARLIEST of the three documents' own dates: a derived pair is only honest
    for a date on which every input it consumed was published.

    The derivation runs INSIDE the ``_PAYLOAD_ERRORS`` guard: a payload with e.g.
    ``Cur_OfficialRate: 0`` only fails when ``derive_nbrb`` divides by it, and that
    is a bad payload, not a crash. ``_finalize`` raises ``FxFetchError``, which is
    not a ``_PAYLOAD_ERRORS`` member and so still propagates unchanged.
    """
    try:
        b = {
            code: _decimal(payloads[code]["Cur_OfficialRate"])
            / _decimal(payloads[code]["Cur_Scale"])
            for code in NBRB_CURRENCIES
        }
        dates = {code: _nbrb_doc_date(payloads[code]) for code in NBRB_CURRENCIES}
        if len(set(dates.values())) > 1:
            logger.warning(
                "nbrb latest documents disagree on date: %s; using %s",
                {code: day.isoformat() for code, day in dates.items()},
                min(dates.values()).isoformat(),
            )
        return derive_nbrb(b, min(dates.values()))
    except _PAYLOAD_ERRORS as exc:
        raise FxFetchError(NBRB, "BAD_PAYLOAD") from exc


def parse_nbrb_dynamics(
    series: Mapping[str, Sequence[Any]], scales: Mapping[str, Decimal]
) -> list[FetchedRate]:
    """Per-currency ``/dynamics`` series -> pairs for every fully-covered date.

    The dynamics documents carry no ``Cur_Scale``, so the scales come from the
    latest-rates documents fetched alongside (a currency's ``Cur_ID`` changes when
    its scale changes, so the scale is fixed for the ``Cur_ID`` being queried).
    Dates missing from any of the three series are skipped rather than guessed.

    As in ``parse_nbrb``, the derivation runs inside the ``_PAYLOAD_ERRORS`` guard so
    that a zero rate (division by zero) reads as BAD_PAYLOAD; ``_finalize``'s
    ``FxFetchError`` is not caught here and propagates unchanged.
    """
    try:
        by_currency: dict[str, dict[date, Decimal]] = {}
        for code, documents in series.items():
            by_currency[code] = {
                _nbrb_doc_date(doc): _decimal(doc["Cur_OfficialRate"]) / scales[code]
                for doc in documents
            }

        covered: set[date] = set(by_currency.get(NBRB_CURRENCIES[0], {}))
        for code in NBRB_CURRENCIES[1:]:
            covered &= set(by_currency.get(code, {}))
        rates: list[FetchedRate] = []
        for as_of in sorted(covered):
            rates.extend(
                derive_nbrb({c: by_currency[c][as_of] for c in NBRB_CURRENCIES}, as_of)
            )
        return rates
    except _PAYLOAD_ERRORS as exc:
        raise FxFetchError(NBRB, "BAD_PAYLOAD") from exc


def parse_frankfurter(payload: Mapping[str, Any]) -> list[FetchedRate]:
    """``/latest?base=EUR&symbols=USD`` -> one EUR->USD rate.

    The as-of date is the payload's own ``date`` (the ECB publication date), NOT
    today: on weekends and holidays frankfurter serves the last published day, and
    stamping it with today would silently invent a rate for a date ECB never priced.
    """
    try:
        as_of = date.fromisoformat(payload["date"])
        rate = _decimal(payload["rates"]["USD"])
    except _PAYLOAD_ERRORS as exc:
        raise FxFetchError(FRANKFURTER, "BAD_PAYLOAD") from exc
    return [FetchedRate("EUR", "USD", _finalize(rate, FRANKFURTER), as_of, FRANKFURTER)]


def parse_frankfurter_range(payload: Mapping[str, Any]) -> list[FetchedRate]:
    """``/{start}..{end}?base=EUR&symbols=USD`` -> one EUR->USD rate per priced day."""
    try:
        days: Mapping[str, Any] = payload["rates"]
        return [
            FetchedRate(
                "EUR",
                "USD",
                _finalize(_decimal(quotes["USD"]), FRANKFURTER),
                date.fromisoformat(day),
                FRANKFURTER,
            )
            for day, quotes in sorted(days.items())
        ]
    except _PAYLOAD_ERRORS as exc:
        raise FxFetchError(FRANKFURTER, "BAD_PAYLOAD") from exc


def _windows(start: date, end: date) -> Iterator[tuple[date, date]]:
    """Split ``[start, end]`` into consecutive windows of at most 365 days."""
    cursor = start
    while cursor <= end:
        stop = min(cursor + timedelta(days=_MAX_WINDOW_DAYS - 1), end)
        yield cursor, stop
        cursor = stop + timedelta(days=1)


class FxRateFetcher:
    """HTTP facade over the two providers. Constructed from Settings, no DB."""

    def __init__(self, settings: Settings) -> None:
        self._frankfurter_base = settings.frankfurter_base_url.rstrip("/")
        self._nbrb_base = settings.nbrb_base_url.rstrip("/")
        self._timeout = settings.fx_http_timeout_seconds

    def _client(self) -> httpx.AsyncClient:
        # Built per call (not per app) so the client never outlives the loop the
        # scheduler job runs on. follow_redirects: providers move endpoints behind
        # 301s and a redirect must not read as HTTP_ERROR.
        return httpx.AsyncClient(timeout=self._timeout, follow_redirects=True)

    async def _get_json(
        self,
        client: httpx.AsyncClient,
        url: str,
        params: Mapping[str, Any],
        provider: str,
    ) -> Any:
        try:
            response = await client.get(url, params=params)
        except httpx.TimeoutException as exc:
            raise FxFetchError(provider, "TIMEOUT") from exc
        except httpx.HTTPError as exc:
            raise FxFetchError(provider, "HTTP_ERROR") from exc
        if response.is_error:
            raise FxFetchError(provider, "HTTP_ERROR")
        try:
            return response.json()
        except ValueError as exc:
            raise FxFetchError(provider, "BAD_PAYLOAD") from exc

    async def fetch_frankfurter_latest(self) -> list[FetchedRate]:
        async with self._client() as client:
            payload = await self._get_json(
                client,
                f"{self._frankfurter_base}/latest",
                {"base": "EUR", "symbols": "USD"},
                FRANKFURTER,
            )
        return parse_frankfurter(payload)

    async def fetch_frankfurter_history(
        self, start: date, end: date
    ) -> list[FetchedRate]:
        rates: list[FetchedRate] = []
        async with self._client() as client:
            for window_start, window_end in _windows(start, end):
                payload = await self._get_json(
                    client,
                    f"{self._frankfurter_base}/{window_start}..{window_end}",
                    {"base": "EUR", "symbols": "USD"},
                    FRANKFURTER,
                )
                rates.extend(parse_frankfurter_range(payload))
        return rates

    async def _fetch_nbrb_documents(self, client: httpx.AsyncClient) -> dict[str, Any]:
        documents: dict[str, Any] = {}
        for code in NBRB_CURRENCIES:
            documents[code] = await self._get_json(
                client,
                f"{self._nbrb_base}/exrates/rates/{code}",
                {"parammode": 2},
                NBRB,
            )
        return documents

    async def fetch_nbrb_latest(self) -> list[FetchedRate]:
        async with self._client() as client:
            documents = await self._fetch_nbrb_documents(client)
        return parse_nbrb(documents)

    async def fetch_nbrb_history(self, start: date, end: date) -> list[FetchedRate]:
        async with self._client() as client:
            # The dynamics endpoint is keyed by numeric Cur_ID and omits Cur_Scale,
            # so the latest documents are fetched first for both.
            documents = await self._fetch_nbrb_documents(client)
            try:
                scales = {
                    code: _decimal(documents[code]["Cur_Scale"])
                    for code in NBRB_CURRENCIES
                }
                cur_ids = {
                    code: int(documents[code]["Cur_ID"]) for code in NBRB_CURRENCIES
                }
            except _PAYLOAD_ERRORS as exc:
                raise FxFetchError(NBRB, "BAD_PAYLOAD") from exc

            series: dict[str, list[Any]] = {code: [] for code in NBRB_CURRENCIES}
            for code in NBRB_CURRENCIES:
                for window_start, window_end in _windows(start, end):
                    payload = await self._get_json(
                        client,
                        f"{self._nbrb_base}/exrates/rates/dynamics/{cur_ids[code]}",
                        {
                            "startDate": window_start.isoformat(),
                            "endDate": window_end.isoformat(),
                        },
                        NBRB,
                    )
                    if not isinstance(payload, list):
                        raise FxFetchError(NBRB, "BAD_PAYLOAD")
                    window_documents: list[Any] = cast(list[Any], payload)
                    series[code].extend(window_documents)
        return parse_nbrb_dynamics(series, scales)
