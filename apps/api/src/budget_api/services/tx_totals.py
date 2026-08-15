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
"""

import uuid
from dataclasses import dataclass
from datetime import date

from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.domain.fx import convert_minor
from budget_api.enums import TransactionKind
from budget_api.models import Transaction
from budget_api.services.fx_lookup import lookup_rate

#: (category_id, kind) → total in the base currency. ``None`` category = uncategorized.
Bucket = tuple[uuid.UUID | None, str]


@dataclass(frozen=True)
class ConvertedTotals:
    income_minor: int
    expense_minor: int
    by_bucket: dict[Bucket, int]
    unconverted_count: int


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
        Transaction.occurred_at >= date_from,
        Transaction.occurred_at < date_to_exclusive,
    )

    # Buckets 1+2. No ELSE arm — an unmatched (bucket-3) row yields NULL and so
    # contributes nothing to this SUM; a group made ONLY of bucket-3 rows sums to
    # NULL, hence the None guard below.
    effective = case(
        (Transaction.currency == base, Transaction.amount_minor),
        (Transaction.base_currency == base, Transaction.base_amount_minor),
    )
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
            select(Transaction).where(
                *period,
                Transaction.currency != base,
                (Transaction.base_currency.is_(None))
                | (Transaction.base_currency != base),
            )
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
