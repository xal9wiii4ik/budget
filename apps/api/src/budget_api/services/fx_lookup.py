"""Read-side rate resolution: nearest-previous stored row, plus inversion (D2).

The read half of the FX pipeline (``services/fx_jobs.py`` is the write half).
Only the 6 directed canonical pairs are ever stored, so the opposite direction is
derived here via ``domain.fx.invert`` — full precision, never quantized.

Shared by three routers (fx, transactions, goals), hence a dedicated services
module rather than inline SQL in the first consumer. ``auto_snapshot`` — the
lookup+convert pair every base-currency snapshot is written through — lives here
too (D8): the transactions router and the recurring materialization job are both
consumers, and ``services`` may not import ``routers``.

Never raises on a missing rate: a rateless pair returns ``None`` and every caller
degrades per D7 (null preview / NULL snapshot / excluded-and-flagged aggregate).
"""

from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.domain.fx import convert_minor, invert
from budget_api.models import ExchangeRate


@dataclass(frozen=True)
class RateLookup:
    rate: Decimal
    """to-per-one-from, full precision (an inverted rate is NOT quantized)."""

    rate_as_of: date
    """The actual stored row's date — disclosed to the client (D2 honesty)."""


async def _nearest_previous(
    session: AsyncSession, base: str, quote: str, on_date: date
) -> ExchangeRate | None:
    """Newest row for ``(base, quote)`` dated at or before ``on_date``.

    ``WHERE base=:b AND quote=:q AND as_of_date <= :d ORDER BY as_of_date DESC
    LIMIT 1`` — a leftmost-prefix range scan on the composite PK, which is why the
    table carries no secondary index (D2).
    """
    return await session.scalar(
        select(ExchangeRate)
        .where(
            ExchangeRate.base == base,
            ExchangeRate.quote == quote,
            ExchangeRate.as_of_date <= on_date,
        )
        .order_by(ExchangeRate.as_of_date.desc())
        .limit(1)
    )


async def lookup_rate(
    session: AsyncSession, base: str, quote: str, on_date: date
) -> RateLookup | None:
    """Resolve the ``base``→``quote`` rate effective on ``on_date``, or ``None``.

    Four steps: identity, direct row, inverse row, nothing. The identity short
    circuit keeps callers branch-free (a same-currency conversion is a normal
    request from the preview endpoint and from the create/PATCH snapshot path).
    """
    if base == quote:
        return RateLookup(rate=Decimal(1), rate_as_of=on_date)

    direct = await _nearest_previous(session, base, quote, on_date)
    if direct is not None:
        return RateLookup(rate=direct.rate, rate_as_of=direct.as_of_date)

    inverse = await _nearest_previous(session, quote, base, on_date)
    if inverse is not None:
        return RateLookup(rate=invert(inverse.rate), rate_as_of=inverse.as_of_date)

    return None


async def auto_snapshot(
    session: AsyncSession,
    amount_minor: int,
    currency: str,
    base: str,
    on_date: date,
) -> tuple[int | None, str | None]:
    """Compute the base-currency snapshot pair, or ``(None, None)`` on a rate miss.

    The single snapshot-WRITE conversion site (D5/D6/D8): every write of a
    ``base_amount_minor``/``base_currency`` pair goes through here — read-side
    conversions (``routers/fx.py``, ``services/goal_reads.py``,
    ``services/tx_totals.py``) pair ``lookup_rate``+``convert_minor`` themselves.
    The rate comes from ``lookup_rate`` (which owns inversion and the
    nearest-previous scan) and the minor→minor scaling from ``convert_minor``
    (which owns the cross-exponent crossing and the one ROUND_HALF_UP quantize).
    A missing rate degrades to the NULL/NULL pair (D7) — never a guessed rate,
    never a 500.
    """
    found = await lookup_rate(session, currency, base, on_date)
    if found is None:
        return None, None
    return convert_minor(amount_minor, currency, base, found.rate), base
