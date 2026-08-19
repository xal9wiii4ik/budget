"""Snapshot-aware converted aggregation over a transaction window (D9).

Born extracted rather than inline at the first consumer (the codebase rule) because
BOTH consumers are known at grooming time: the monthly summary (S3) and the goals
free-balance window (S5). Building it here avoids S5 refactoring S3's router.

Three buckets, two passes:

1. ``currency == base``  — the native amount IS the base amount.
2. ``base_currency == base`` — the stored snapshot (auto or user override) is the
   base amount.
3. everything else — no usable snapshot; converted at read time, or excluded and
   counted.

Buckets 1+2 are one grouped SQL pass (the hot path — the overwhelming majority of
rows). The CASE arm order is load-bearing: after a base change RUB→EUR a row
``currency=EUR, base_currency=RUB`` hits arm 1, so a stale snapshot is bypassed for
free instead of being summed as EUR. Bucket 3 is a Python fold-in over rows that
are structurally rare (foreign row whose snapshot predates a base change, or whose
rate did not exist at write time).

Never mixes currencies and never errors: a bucket-3 row with no rate is EXCLUDED
from every sum and counted in ``unconverted_count`` (exclude-and-flag, D9/D7).

Transfers are OUT of every population here (``_NOT_TRANSFER``, architecture §6):
moving money between two of the user's own accounts is not income and not expense,
so the exclusion lives at the source and every consumer of this module — the two
summaries, the dynamics chart, top merchants, limits, goals, the advisor context —
inherits it without a filter of its own.

4.1 grew two more series on the SAME three buckets (D2 — generalize, never fork a
parallel stats module): ``monthly_converted_totals`` (the dynamics chart) and
``merchant_converted_totals`` (top merchants). Both do ONE grouped pass plus ONE
bucket-3 scan over the whole window — never N calls to ``converted_totals``.
"""

import uuid
from dataclasses import dataclass
from datetime import date

from sqlalchemy import Case, ColumnElement, Select, case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.domain.fx import convert_minor
from budget_api.domain.periods import shift_month
from budget_api.enums import TransactionKind
from budget_api.models import Transaction
from budget_api.services.fx_lookup import lookup_rate

#: (category_id, kind) → total in the base currency. ``None`` category = uncategorized.
Bucket = tuple[uuid.UUID | None, str]
#: (year, month) — the monthly fold-in key (``date_trunc`` yields a timestamp).
_MonthKey = tuple[int, int]


#: A transfer moves money between two of the user's OWN accounts (architecture §6):
#: it is neither income nor expense, and no series in this module may see one. ONE
#: definition applied in all FOUR passes below — the three grouped selects AND
#: ``_bucket_three_rows`` (plan risk 5): a transfer carries a NULL base snapshot by
#: DB CHECK, so its foreign leg lands in bucket 3 by construction, would be
#: converted at read time, and the monthly fold-in (``income if kind == income else
#: expense``) would book it as an EXPENSE. Filtering only the grouped passes would
#: therefore hide the bug on base-currency transfers and ship it on foreign ones.
_NOT_TRANSFER: ColumnElement[bool] = Transaction.kind != TransactionKind.transfer.value


@dataclass(frozen=True)
class ConvertedTotals:
    income_minor: int
    expense_minor: int
    by_bucket: dict[Bucket, int]
    unconverted_count: int


@dataclass(frozen=True)
class MonthTotals:
    """One point of the dynamics series. ``month`` is the first of that month."""

    month: date
    income_minor: int
    expense_minor: int
    unconverted_count: int


@dataclass(frozen=True)
class MerchantTotal:
    merchant: str
    total_minor: int
    tx_count: int


@dataclass(frozen=True)
class MerchantTotals:
    items: list[MerchantTotal]
    unconverted_count: int


def _effective_base_minor(base: str) -> Case[int]:
    """Buckets 1+2 as ONE expression — the single definition all three series use.

    No ELSE arm: an unmatched (bucket-3) row yields NULL, so it contributes
    nothing to a SUM and is not seen by COUNT; the Python fold-in owns it. The arm
    order is load-bearing (see the module docstring) — which is exactly why it is
    written once here instead of copied per query.
    """
    return case(
        (Transaction.currency == base, Transaction.amount_minor),
        (Transaction.base_currency == base, Transaction.base_amount_minor),
    )


def _bucket_three_rows(
    user_id: uuid.UUID, base: str, date_from: date, date_to_exclusive: date
) -> Select[tuple[Transaction]]:
    """Rows with no usable snapshot: converted at read time, or excluded+flagged."""
    return select(Transaction).where(
        Transaction.user_id == user_id,
        _NOT_TRANSFER,
        Transaction.occurred_at >= date_from,
        Transaction.occurred_at < date_to_exclusive,
        Transaction.currency != base,
        (Transaction.base_currency.is_(None)) | (Transaction.base_currency != base),
    )


async def converted_totals(
    session: AsyncSession,
    user_id: uuid.UUID,
    base: str,
    date_from: date,
    date_to_exclusive: date,
) -> ConvertedTotals:
    """Total ``user_id``'s ``[date_from, date_to_exclusive)`` rows in ``base``.

    One grouped query serves the totals AND the per-category breakdown; the
    per-row fold-in below only touches bucket-3 rows.
    """
    period = (
        Transaction.user_id == user_id,
        _NOT_TRANSFER,
        Transaction.occurred_at >= date_from,
        Transaction.occurred_at < date_to_exclusive,
    )

    # Buckets 1+2; a group made ONLY of bucket-3 rows sums to NULL, hence the
    # None guard below.
    effective = _effective_base_minor(base)
    grouped = (
        await session.execute(
            select(
                Transaction.category_id,
                Transaction.kind,
                func.sum(effective).label("total"),
            )
            .where(*period)
            .group_by(Transaction.category_id, Transaction.kind)
        )
    ).all()

    by_bucket: dict[Bucket, int] = {}
    for category_id, kind, total in grouped:
        if total is None:
            continue  # every row in this group was bucket 3 — the fold-in owns it
        by_bucket[(category_id, kind)] = int(total)

    # Bucket 3 — display-time conversion of the NATIVE amount (never of the stale
    # snapshot, whose currency is no longer the base).
    unconverted_count = 0
    stale = (
        await session.scalars(
            _bucket_three_rows(user_id, base, date_from, date_to_exclusive)
        )
    ).all()
    for row in stale:
        found = await lookup_rate(session, row.currency, base, row.occurred_at)
        if found is None:
            unconverted_count += 1  # excluded from every sum, surfaced to the client
            continue
        bucket: Bucket = (row.category_id, row.kind)
        converted = convert_minor(row.amount_minor, row.currency, base, found.rate)
        by_bucket[bucket] = by_bucket.get(bucket, 0) + converted

    income_minor = sum(
        total
        for (_, kind), total in by_bucket.items()
        if kind == TransactionKind.income.value
    )
    expense_minor = sum(
        total
        for (_, kind), total in by_bucket.items()
        if kind == TransactionKind.expense.value
    )
    return ConvertedTotals(
        income_minor=income_minor,
        expense_minor=expense_minor,
        by_bucket=by_bucket,
        unconverted_count=unconverted_count,
    )


async def monthly_converted_totals(
    session: AsyncSession,
    user_id: uuid.UUID,
    base: str,
    *,
    months: int,
    ending_first: date,
) -> list[MonthTotals]:
    """Dense ASCENDING series of ``months`` calendar months ending at ``ending_first``.

    Window = ``[shift_month(ending_first, -(months - 1)),
    shift_month(ending_first, 1))`` — the caller's month is INCLUDED (the
    goals-progress precedent). Empty months are emitted as zeros so the chart
    never has to reconstruct a gap.

    ONE grouped pass over the whole window plus ONE bucket-3 scan folded per month
    in Python (D2) — never ``months`` calls to :func:`converted_totals`.
    """
    window_start = shift_month(ending_first, -(months - 1))
    window_end = shift_month(ending_first, 1)

    # date_trunc returns a TIMESTAMP, so the bucket key is read off .year/.month
    # (the shipped goal_progress pattern) rather than compared as a date.
    month_col = func.date_trunc("month", Transaction.occurred_at)
    effective = _effective_base_minor(base)
    grouped = (
        await session.execute(
            select(month_col, Transaction.kind, func.sum(effective).label("total"))
            .where(
                Transaction.user_id == user_id,
                _NOT_TRANSFER,
                Transaction.occurred_at >= window_start,
                Transaction.occurred_at < window_end,
            )
            .group_by(month_col, Transaction.kind)
        )
    ).all()

    income: dict[_MonthKey, int] = {}
    expense: dict[_MonthKey, int] = {}
    unconverted: dict[_MonthKey, int] = {}
    for bucket, kind, total in grouped:
        if total is None:
            continue  # every row in this group was bucket 3 — the fold-in owns it
        key: _MonthKey = (bucket.year, bucket.month)
        side = income if kind == TransactionKind.income.value else expense
        side[key] = side.get(key, 0) + int(total)

    stale = (
        await session.scalars(
            _bucket_three_rows(user_id, base, window_start, window_end)
        )
    ).all()
    for row in stale:
        key = (row.occurred_at.year, row.occurred_at.month)
        found = await lookup_rate(session, row.currency, base, row.occurred_at)
        if found is None:
            # Per-POINT flag (D4): one flagged month must not cast doubt on the
            # eleven clean ones around it.
            unconverted[key] = unconverted.get(key, 0) + 1
            continue
        side = income if row.kind == TransactionKind.income.value else expense
        side[key] = side.get(key, 0) + convert_minor(
            row.amount_minor, row.currency, base, found.rate
        )

    points: list[MonthTotals] = []
    for offset in range(months):
        month_first = shift_month(window_start, offset)
        key = (month_first.year, month_first.month)
        points.append(
            MonthTotals(
                month=month_first,
                income_minor=income.get(key, 0),
                expense_minor=expense.get(key, 0),
                unconverted_count=unconverted.get(key, 0),
            )
        )
    return points


async def merchant_converted_totals(
    session: AsyncSession,
    user_id: uuid.UUID,
    base: str,
    date_from: date,
    date_to_exclusive: date,
    *,
    kind: TransactionKind,
    limit: int,
) -> MerchantTotals:
    """Top ``limit`` merchants of one ``kind`` over the window, in ``base``.

    Merchants are grouped by the VERBATIM stored string (no normalization — that
    is a recorded re-visit trigger, not a silent fold). NULL-merchant rows are out
    of the population entirely: "top merchants" over merchantless rows is not a
    bucket, so they are neither an item nor a flag.

    A row with no rate is excluded from BOTH ``total_minor`` and ``tx_count`` and
    counted once in ``unconverted_count`` — the count and the total must describe
    the same row set. A merchant left with zero INCLUDED rows is omitted from
    ``items`` entirely: a ``(merchant, 0, 0)`` row would read as "spent nothing
    here", which is a lie; ``unconverted_count`` is the honest signal.

    The top-``limit`` cut is applied AFTER the fold-in — a bucket-3 row can
    reorder the tail. Ties break on the merchant string so the order is
    deterministic (an unordered tie jitters a pagination-free UI).
    """
    of_kind = (
        Transaction.merchant.is_not(None),
        Transaction.kind == kind.value,
    )
    effective = _effective_base_minor(base)
    grouped = (
        await session.execute(
            select(
                Transaction.merchant,
                func.sum(effective).label("total"),
                # COUNT of the same expression: bucket-3 rows are NULL here, so
                # they are absent from the count exactly as they are from the sum.
                func.count(effective).label("tx_count"),
            )
            .where(
                Transaction.user_id == user_id,
                # Redundant here — ``of_kind`` already pins one non-transfer kind,
                # and this route has no ``?kind=`` knob — but the predicate is
                # applied in every pass of this module on purpose: one point of
                # truth beats four spots where three of them happen to be right.
                _NOT_TRANSFER,
                Transaction.occurred_at >= date_from,
                Transaction.occurred_at < date_to_exclusive,
                *of_kind,
            )
            .group_by(Transaction.merchant)
        )
    ).all()

    totals: dict[str, int] = {}
    counts: dict[str, int] = {}
    for merchant, total, tx_count in grouped:
        if total is None:
            continue  # merchant with only unconvertible rows — omitted, not zeroed
        totals[merchant] = int(total)
        counts[merchant] = int(tx_count)

    unconverted_count = 0
    stale = (
        await session.scalars(
            _bucket_three_rows(user_id, base, date_from, date_to_exclusive).where(
                *of_kind
            )
        )
    ).all()
    for row in stale:
        assert row.merchant is not None  # SQL-guarded above
        found = await lookup_rate(session, row.currency, base, row.occurred_at)
        if found is None:
            unconverted_count += 1
            continue
        totals[row.merchant] = totals.get(row.merchant, 0) + convert_minor(
            row.amount_minor, row.currency, base, found.rate
        )
        counts[row.merchant] = counts.get(row.merchant, 0) + 1

    ordered = sorted(totals.items(), key=lambda item: (-item[1], item[0]))
    return MerchantTotals(
        items=[
            MerchantTotal(
                merchant=merchant, total_minor=total, tx_count=counts[merchant]
            )
            for merchant, total in ordered[:limit]
        ],
        unconverted_count=unconverted_count,
    )
