"""Provider payload interpretation — pure helpers, no HTTP, no DB.

The derivation math (Cur_Scale, inversion, cross-via-BYN, the 8 dp quantization)
is where a silent 100x money bug lives, so it is unit-tested directly on canned
payloads (the domain/merchant.py precedent for internal pure branchy logic). The
HTTP plumbing around these helpers is covered live at /test, never in pytest.
"""

from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

import pytest

from budget_api.services.fx_rates import (
    FxFetchError,
    parse_frankfurter,
    parse_frankfurter_range,
    parse_nbrb,
)

_DAY = "2026-08-14"


def _nbrb_docs(rub_scale: int = 100) -> dict[str, dict[str, Any]]:
    """Canned ``/exrates/rates/{code}?parammode=2`` documents.

    Realistic shape: USD/EUR are quoted per 1 unit, RUB per 100 (the whole reason
    ``Cur_Scale`` exists).
    """
    return {
        "USD": {
            "Cur_ID": 431,
            "Date": f"{_DAY}T00:00:00",
            "Cur_Abbreviation": "USD",
            "Cur_Scale": 1,
            "Cur_OfficialRate": 3.4,
        },
        "EUR": {
            "Cur_ID": 451,
            "Date": f"{_DAY}T00:00:00",
            "Cur_Abbreviation": "EUR",
            "Cur_Scale": 1,
            "Cur_OfficialRate": 3.74,
        },
        "RUB": {
            "Cur_ID": 456,
            "Date": f"{_DAY}T00:00:00",
            "Cur_Abbreviation": "RUB",
            "Cur_Scale": rub_scale,
            "Cur_OfficialRate": 3.4,
        },
    }


def _by_pair(rates: list[Any]) -> dict[tuple[str, str], Decimal]:
    return {(rate.base, rate.quote): rate.rate for rate in rates}


class TestNbrbDerivation:
    def test_derivation_honors_cur_scale(self) -> None:
        # Same Cur_OfficialRate (3.4) for RUB under two scales. Honoring the scale
        # gives b(RUB) = 0.034 -> BYN->RUB = 1/0.034 ~ 29.4 (roubles per BYN, the
        # plausible direction); assuming scale 1 gives b(RUB) = 3.4 -> 0.294, i.e.
        # exactly 100x off. The two arms must NOT agree.
        honored = _by_pair(parse_nbrb(_nbrb_docs(rub_scale=100)))
        ignored = _by_pair(parse_nbrb(_nbrb_docs(rub_scale=1)))

        assert honored[("BYN", "RUB")] == Decimal("29.41176471")
        assert ignored[("BYN", "RUB")] == Decimal("0.29411765")
        assert honored[("RUB", "USD")] == Decimal("0.01")
        assert ignored[("RUB", "USD")] == Decimal("1")

    def test_inversion_and_cross_exact(self) -> None:
        # b(USD)=3.4, b(EUR)=3.74, b(RUB)=3.4/100=0.034. Hand-computed, quantized to
        # 8 dp ROUND_HALF_UP. RUB->USD is the CROSS b(RUB)/b(USD)=0.01, not the
        # inversion 1/b(USD)=0.29411765 — the two are far apart, so an inversion
        # mistake in the cross cannot pass this test.
        rates = parse_nbrb(_nbrb_docs())

        assert _by_pair(rates) == {
            ("BYN", "USD"): Decimal("0.29411765"),
            ("BYN", "EUR"): Decimal("0.26737968"),
            ("BYN", "RUB"): Decimal("29.41176471"),
            ("RUB", "USD"): Decimal("0.01"),
            ("RUB", "EUR"): Decimal("0.00909091"),
        }
        assert {rate.provider for rate in rates} == {"nbrb"}
        assert {rate.as_of_date for rate in rates} == {date(2026, 8, 14)}


class TestFrankfurterParse:
    def test_as_of_comes_from_payload_date(self) -> None:
        # frankfurter serves the last PUBLISHED day on weekends/holidays, so the
        # payload's own date (here, deliberately in the past) is the as-of date —
        # stamping it with today would invent a rate for an unpriced date.
        rates = parse_frankfurter(
            {"amount": 1.0, "base": "EUR", "date": _DAY, "rates": {"USD": 1.0955}}
        )

        assert len(rates) == 1
        assert rates[0].as_of_date == date(2026, 8, 14)
        assert rates[0].as_of_date != datetime.now(UTC).date()
        assert rates[0].rate == Decimal("1.0955")

    def test_range_payload_yields_one_rate_per_priced_day(self) -> None:
        rates = parse_frankfurter_range(
            {
                "base": "EUR",
                "rates": {"2026-08-13": {"USD": 1.09}, "2026-08-14": {"USD": 1.1}},
            }
        )

        assert [(rate.as_of_date, rate.rate) for rate in rates] == [
            (date(2026, 8, 13), Decimal("1.09")),
            (date(2026, 8, 14), Decimal("1.1")),
        ]


class TestBadPayload:
    @pytest.mark.parametrize(
        "payload",
        [
            {"amount": 1.0, "base": "EUR", "date": _DAY},
            {"amount": 1.0, "base": "EUR", "rates": {"USD": 1.0955}},
            {"amount": 1.0, "base": "EUR", "date": _DAY, "rates": {"CHF": 0.94}},
        ],
        ids=["no-rates", "no-date", "wrong-symbol"],
    )
    def test_frankfurter_missing_keys(self, payload: dict[str, Any]) -> None:
        with pytest.raises(FxFetchError) as exc_info:
            parse_frankfurter(payload)

        assert exc_info.value.provider == "frankfurter"
        assert exc_info.value.code == "BAD_PAYLOAD"

    @pytest.mark.parametrize("missing", ["Cur_OfficialRate", "Cur_Scale", "Date"])
    def test_nbrb_missing_keys(self, missing: str) -> None:
        documents = _nbrb_docs()
        del documents["RUB"][missing]

        with pytest.raises(FxFetchError) as exc_info:
            parse_nbrb(documents)

        assert exc_info.value.provider == "nbrb"
        assert exc_info.value.code == "BAD_PAYLOAD"
