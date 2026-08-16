"""Stats endpoints: summary + previous period, monthly dynamics, top merchants (D4).

This router computes NO math. It resolves the period (``resolve_period`` below,
the ONE server-side period grammar — D5), calls the shared snapshot-aware
aggregates in ``services/tx_totals`` (the same three-bucket conversion the monthly
summary and the goals free balance ride), sorts, and shapes DTOs. Every window
boundary comes from the pure ``domain/periods``.

Auth-required, DB-only reads: no rate limit and no ``prime_rate_limit`` mount
dependency (the categories/fx/goals precedent). Base currency is the read-only
profile fallback — a GET never writes a profile (``services/profile_reads``).

Goals progress is NOT re-served here (D4): ``GET /goals`` and
``GET /goals/{id}/progress`` already return render-ready series, and a second
assembler could only drift from the numbers the goals screen shows.
"""

from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import Field
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.auth import current_active_user
from budget_api.db import get_session
from budget_api.domain.periods import (
    MAX_DATE,
    MAX_YEAR,
    MIN_DATE,
    MIN_YEAR,
    MONTH_PATTERN,
    QUARTER_PATTERN,
    PeriodUnit,
    month_bounds,
    month_key,
    previous_period,
    quarter_bounds,
    year_bounds,
)
from budget_api.enums import TransactionKind
from budget_api.models import User
from budget_api.schemas.stats import (
    MerchantTotalRead,
    MonthlyPoint,
    MonthlyRead,
    PeriodBounds,
    PeriodTotals,
    StatsError,
    StatsSummaryRead,
    TopMerchantsRead,
)
from budget_api.schemas.transaction import CategorySummary
from budget_api.services.profile_reads import read_base_currency
from budget_api.services.tx_totals import (
    ConvertedTotals,
    converted_totals,
    merchant_converted_totals,
    monthly_converted_totals,
)

router = APIRouter()

# Declared on EVERY route here (the fastapi-users /users precedent, which is the
# only other place a 401 is in the contract): all three routes are auth-required
# and answer {"detail": "Unauthorized"} — the StatsError shape.
#
# It is also load-bearing for the union below: FastAPI only emits a component for
# a model it sees on a `responses` entry, and the anyOf arm is a raw $ref (a
# `"model"` on the SAME response would be merged INTO that schema as a sibling
# $ref, which makes openapi-typescript drop the union and generate a type that
# lies about the validation arm — verified). The older routers get StatsError's
# equivalent registered by their 404s; /stats has no 404, so the honest 401 is
# what anchors it. See the /implement report (deviation).
_UNAUTHORIZED: dict[int | str, dict[str, object]] = {
    status.HTTP_401_UNAUTHORIZED: {"model": StatsError}
}
# The honest anyOf union (AM-5, copied from routers/transactions.py): the two
# period-scoped routes emit BOTH our business code ({"detail": "PERIOD_ANCHOR_
# REQUIRED"}, StatsError) and FastAPI's Pydantic array (HTTPValidationError, e.g.
# a malformed `month`). Declaring only the model would make the generated type lie
# about one arm. HTTPValidationError is referenced, never hand-declared.
_UNPROCESSABLE: dict[int | str, dict[str, object]] = {
    status.HTTP_422_UNPROCESSABLE_CONTENT: {
        "description": "Business rule rejection (string code) or validation error",
        "content": {
            "application/json": {
                "schema": {
                    "anyOf": [
                        {"$ref": "#/components/schemas/StatsError"},
                        {"$ref": "#/components/schemas/HTTPValidationError"},
                    ]
                }
            }
        },
    }
}


def _today() -> date:
    return datetime.now(UTC).date()


def _inclusive_to(date_to_exclusive: date) -> date:
    """Internal ``to_exclusive`` → the inclusive ``to`` the wire echoes."""
    return date_to_exclusive - timedelta(days=1)


#: The custom unit's two dates, carrying the SAME year envelope as the three anchor
#: patterns and enforced at the same (Query) layer: `to + 1 day` overflows at
#: `date.max` and the previous window's echoed `to` underflows at `date.min`, so an
#: unbounded date pair is two 500s on syntactically valid input.
#:
#: The bound rides the TYPE rather than `Query(ge=..., le=...)` because FastAPI types
#: those kwargs `float | None` (a stub limitation — the runtime accepts dates), which
#: pyright rejects. Pydantic enforces it either way but drops date ge/le from the JSON
#: Schema, so the param still renders as a plain `{"type": "string", "format": "date"}`
#: — same class of contract-invisibility as the patterns above, which openapi-typescript
#: also cannot express in a type. The declared 422 arm is what a client is told.
BoundedDate = Annotated[date, Field(ge=MIN_DATE, le=MAX_DATE)]


@dataclass(frozen=True)
class ResolvedPeriod:
    """One resolved window plus its comparison window, all half-open internally."""

    unit: PeriodUnit
    date_from: date
    date_to_exclusive: date
    prev_from: date
    prev_to_exclusive: date


async def resolve_period(
    period: PeriodUnit = Query(...),
    month: str | None = Query(default=None, pattern=MONTH_PATTERN),
    quarter: str | None = Query(default=None, pattern=QUARTER_PATTERN),
    year: int | None = Query(default=None, ge=MIN_YEAR, le=MAX_YEAR),
    from_: BoundedDate | None = Query(default=None, alias="from"),
    to: BoundedDate | None = Query(default=None),
) -> ResolvedPeriod:
    """The shared period grammar for ``/stats/summary`` and ``/stats/top-merchants``.

    ``period`` is REQUIRED and selects which anchor is read: ``month=YYYY-MM``,
    ``quarter=YYYY-Q[1-4]``, ``year=YYYY``, or ``from``+``to`` for ``custom``.
    A missing anchor for the CHOSEN unit is 422 ``PERIOD_ANCHOR_REQUIRED``.

    **Redundant-but-correct anchors are IGNORED**: only the chosen unit's anchor
    is read, so ``period=month&month=2026-02&quarter=2026-Q1`` answers exactly as
    ``period=month&month=2026-02`` does. A client switching tabs leaves stale
    params behind and its intent is unambiguous; "mismatched" means the chosen
    unit's anchor is ABSENT, not that another unit's is present.

    ``from > to`` on custom is NOT an error (read filters never error, decision l):
    the window resolves empty and the aggregate returns zeros.

    Every anchor — all four units — lives inside ``MIN_YEAR..MAX_YEAR``; outside it
    the window math would overflow ``date`` itself, so it is a 422, not a 500.
    """
    if period is PeriodUnit.month:
        if month is None:
            raise _anchor_required()
        date_from, date_to_exclusive = month_bounds(month)
    elif period is PeriodUnit.quarter:
        if quarter is None:
            raise _anchor_required()
        date_from, date_to_exclusive = quarter_bounds(quarter)
    elif period is PeriodUnit.year:
        if year is None:
            raise _anchor_required()
        date_from, date_to_exclusive = year_bounds(year)
    else:
        if from_ is None or to is None:
            raise _anchor_required()
        # `to` is INCLUSIVE on the wire; everything downstream is half-open.
        date_from, date_to_exclusive = from_, to + timedelta(days=1)
    prev_from, prev_to_exclusive = previous_period(period, date_from, date_to_exclusive)
    return ResolvedPeriod(
        unit=period,
        date_from=date_from,
        date_to_exclusive=date_to_exclusive,
        prev_from=prev_from,
        prev_to_exclusive=prev_to_exclusive,
    )


def _anchor_required() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        detail="PERIOD_ANCHOR_REQUIRED",
    )


def _bounds(date_from: date, date_to_exclusive: date) -> PeriodBounds:
    return PeriodBounds(from_=date_from, to=_inclusive_to(date_to_exclusive))


@router.get(
    "/summary",
    response_model=StatsSummaryRead,
    responses={**_UNAUTHORIZED, **_UNPROCESSABLE},
)
async def stats_summary(
    # AUTH FIRST — parameter order is load-bearing (same landmine as the advisor
    # route): FastAPI resolves dependencies in signature order and `resolve_period`
    # RAISES its own 422, so an unauthenticated anchorless request would answer 422
    # instead of 401 if `period` came first. Pinned by test_stats_requires_auth.
    user: User = Depends(current_active_user),
    period: ResolvedPeriod = Depends(resolve_period),
    session: AsyncSession = Depends(get_session),
) -> StatsSummaryRead:
    currency = await read_base_currency(session, user.id)
    totals = await converted_totals(
        session, user.id, currency, period.date_from, period.date_to_exclusive
    )
    prev = await converted_totals(
        session, user.id, currency, period.prev_from, period.prev_to_exclusive
    )
    # The 1.4/3.2 summary ordering (kind, total DESC); the Python fold-in has no
    # SQL ordering of its own, so it is applied here.
    by_category = [
        CategorySummary(
            category_id=category_id, kind=TransactionKind(kind), total_minor=total
        )
        for (category_id, kind), total in sorted(
            totals.by_bucket.items(), key=lambda item: (item[0][1], -item[1])
        )
    ]
    return StatsSummaryRead(
        period=_bounds(period.date_from, period.date_to_exclusive),
        currency=currency,
        income_minor=totals.income_minor,
        expense_minor=totals.expense_minor,
        net_minor=_net(totals),
        by_category=by_category,
        unconverted_count=totals.unconverted_count,
        previous=PeriodTotals(
            from_=period.prev_from,
            to=_inclusive_to(period.prev_to_exclusive),
            income_minor=prev.income_minor,
            expense_minor=prev.expense_minor,
            net_minor=_net(prev),
            unconverted_count=prev.unconverted_count,
        ),
    )


def _net(totals: ConvertedTotals) -> int:
    return totals.income_minor - totals.expense_minor  # signed


@router.get("/monthly", response_model=MonthlyRead, responses=_UNAUTHORIZED)
async def stats_monthly(
    months: int = Query(default=12, ge=1, le=60),
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_session),
) -> MonthlyRead:
    """Trailing ``months`` calendar months, current (partial) month INCLUDED.

    No business 422 of its own — ``months`` is a bounded Query, so the automatic
    ``HTTPValidationError`` is the only honest 422 arm and no ``responses``
    override is declared.
    """
    currency = await read_base_currency(session, user.id)
    series = await monthly_converted_totals(
        session,
        user.id,
        currency,
        months=months,
        ending_first=_today().replace(day=1),
    )
    return MonthlyRead(
        currency=currency,
        points=[
            MonthlyPoint(
                month=month_key(point.month),
                income_minor=point.income_minor,
                expense_minor=point.expense_minor,
                net_minor=point.income_minor - point.expense_minor,  # signed
                unconverted_count=point.unconverted_count,
            )
            for point in series
        ],
    )


@router.get(
    "/top-merchants",
    response_model=TopMerchantsRead,
    responses={**_UNAUTHORIZED, **_UNPROCESSABLE},
)
async def stats_top_merchants(
    # AUTH FIRST — parameter order is load-bearing, see `stats_summary`.
    user: User = Depends(current_active_user),
    period: ResolvedPeriod = Depends(resolve_period),
    limit: int = Query(default=10, ge=1, le=50),
    session: AsyncSession = Depends(get_session),
) -> TopMerchantsRead:
    """EXPENSE rows only — there is no ``kind`` knob.

    "Куда уходят деньги" is the asked-for view; a "top income sources" screen was
    never requested, and a knob nobody asked for is speculative config. Adding
    ``?kind=`` later is purely additive.
    """
    currency = await read_base_currency(session, user.id)
    totals = await merchant_converted_totals(
        session,
        user.id,
        currency,
        period.date_from,
        period.date_to_exclusive,
        kind=TransactionKind.expense,
        limit=limit,
    )
    return TopMerchantsRead(
        period=_bounds(period.date_from, period.date_to_exclusive),
        currency=currency,
        items=[
            MerchantTotalRead(
                merchant=item.merchant,
                total_minor=item.total_minor,
                tx_count=item.tx_count,
            )
            for item in totals.items
        ],
        unconverted_count=totals.unconverted_count,
    )
