"""Per-category monthly limits — set / clear / list with spend (D14 through D18).

Three routes over one composite-PK table. The interesting halves are the write's
currency stamp and the read's fold:

* **PUT is an upsert, not a read-modify-write**: ``ON CONFLICT (user_id,
  category_id) DO UPDATE`` (the ``merchant_category_map`` construction) — the
  natural PK *is* the conflict target, so "set my grocery limit" is idempotent
  and two concurrent writers cannot produce two rows. The stored ``currency`` is
  stamped from the profile base AT SET TIME and is never converted or
  re-interpreted afterwards (D15/OQ-4); a later base switch surfaces as a
  mismatch on the read, and only a rewrite re-stamps it.
* **GET computes NO aggregation of its own** (D16): it calls the same
  snapshot-aware ``services/tx_totals.converted_totals`` the monthly summary and
  /stats ride, and reads the EXPENSE bucket of each limited category out of
  ``by_bucket``. A second fold here could only drift from the numbers the stats
  screen shows for the same month.

Scoping and honesty rules this router inherits rather than invents: every query
is filtered by ``user_id``; the base currency is the read-only profile read (a
GET never writes a profile); unconvertible rows are excluded from every sum and
counted once for the period.

Error shape: the category is the ADDRESSED resource on PUT, so a foreign or
missing one is 404 ``CATEGORY_NOT_FOUND`` (one code path, no-oracle) rather than
the body-ref 422 the transactions/recurring routers use; a visible category that
cannot legally carry a budget is 422 (``CATEGORY_ARCHIVED``,
``CATEGORY_NOT_EXPENSE`` — OQ-7: an income category has no "spending" to cap).
DELETE resolves foreign and missing alike to 404 ``LIMIT_NOT_FOUND``.

Categories with spending but no limit are ABSENT from the list (this endpoint
lists budgets, not spending — /stats owns the breakdown), while a limit whose
category was archived after the fact IS returned: the row is still the user's
declared threshold and hiding it would strand it in the database with no UI to
delete it.
"""

import uuid
from datetime import UTC, date, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.category_access import load_visible_category
from budget_api.db import get_session
from budget_api.domain.periods import MONTH_PATTERN, month_bounds, month_key
from budget_api.enums import CategoryKind, TransactionKind
from budget_api.mcp import prose
from budget_api.mcp.decorator import mcp_tool
from budget_api.models import CategoryLimit, User
from budget_api.pat_auth import current_user_jwt_or_pat
from budget_api.schemas.limit import (
    LimitError,
    LimitItem,
    LimitRead,
    LimitsRead,
    LimitUpsert,
)
from budget_api.services.profile_reads import read_base_currency
from budget_api.services.tx_totals import converted_totals

router = APIRouter()

# Mirrors routers/goals.py: stable UPPER_SNAKE codes carried in {"detail": ...}.
_NOT_FOUND: dict[int | str, dict[str, object]] = {
    status.HTTP_404_NOT_FOUND: {"model": LimitError}
}
# The honest anyOf union (receipts V2/AM-5): PUT emits BOTH business codes
# (LimitError — CATEGORY_ARCHIVED / CATEGORY_NOT_EXPENSE) and FastAPI's auto
# Pydantic array (HTTPValidationError — an out-of-bounds amount_minor), so
# declaring only the model would make the generated client type lie about one
# arm. GET deliberately does NOT carry this union: its only 422 is the
# `month` pattern, i.e. the auto arm alone.
_UNPROCESSABLE: dict[int | str, dict[str, object]] = {
    status.HTTP_422_UNPROCESSABLE_CONTENT: {
        "description": "Business rule rejection (string code) or validation error",
        "content": {
            "application/json": {
                "schema": {
                    "anyOf": [
                        {"$ref": "#/components/schemas/LimitError"},
                        {"$ref": "#/components/schemas/HTTPValidationError"},
                    ]
                }
            }
        },
    }
}


def _today() -> date:
    return datetime.now(UTC).date()


@router.get("", response_model=LimitsRead)
@mcp_tool(
    name="list_limits",
    description=(
        "Monthly spending limits per category together with the amount already spent "
        "— the spend is computed by the server in the base currency, do not "
        "recompute it."
    ),
    params={
        "month": "Month as YYYY-MM; defaults to the current month.",
    },
)
async def list_limits(
    # AUTH FIRST — the /stats precedent: FastAPI resolves dependencies in
    # signature order, so keeping the user dependency ahead of the query params
    # is what makes an unauthenticated malformed request answer 401, not 422.
    user: User = Depends(current_user_jwt_or_pat),
    month: str | None = Query(default=None, pattern=MONTH_PATTERN),
    session: AsyncSession = Depends(get_session),
) -> LimitsRead:
    """Every limit the user owns, each with its spend for ``month``.

    ``month`` defaults to the current UTC month (D16) — the screen that renders
    this is "how am I doing right now", so requiring an anchor would make the
    common call the verbose one. The response ECHOES the resolved month so a
    client never has to reconstruct which window it is looking at.
    """
    resolved = month if month is not None else month_key(_today())
    base = await read_base_currency(session, user.id)
    first, next_first = month_bounds(resolved)
    totals = await converted_totals(session, user.id, base, first, next_first)
    rows = (
        await session.scalars(
            select(CategoryLimit).where(CategoryLimit.user_id == user.id)
        )
    ).all()
    # Ordered by the category id's string form: the list has no natural order
    # (names live on another table and the row carries no rank), and an
    # unordered list jitters a pagination-free UI between renders.
    items = [
        LimitItem(
            category_id=row.category_id,
            limit_minor=row.amount_minor,
            limit_currency=row.currency,
            # EXPENSE bucket only (D16): income rows in a limited category are a
            # different fact, not negative spending.
            spent_minor=totals.by_bucket.get(
                (row.category_id, TransactionKind.expense.value), 0
            ),
        )
        for row in sorted(rows, key=lambda row: str(row.category_id))
    ]
    return LimitsRead(
        month=resolved,
        currency=base,
        items=items,
        unconverted_count=totals.unconverted_count,
    )


@router.put(
    "/{category_id}",
    response_model=LimitRead,
    responses={**_NOT_FOUND, **_UNPROCESSABLE},
)
@mcp_tool(
    name="set_category_limit",
    description=(
        "Set the monthly limit for ONE category — a full upsert: what you send "
        "REPLACES the current limit, it never adds a second one. amount_minor is in "
        "the user's base currency, which the server stamps. Only expense categories "
        "can carry a limit. Call list_limits first to see the current limit and this "
        "month's spend."
    ),
    params={
        "category_id": (prose.CATEGORY_ID + " Must be an expense category."),
        "amount_minor": (
            "The monthly cap in INTEGER MINOR UNITS of the base currency: 250 EUR is "
            "25000; JPY has no minor unit, so 500 JPY is 500. Never scale or convert "
            "it yourself — use convert_currency and get_stats_summary.currency for "
            "the base currency."
        ),
    },
)
async def set_limit(
    category_id: uuid.UUID,
    payload: LimitUpsert,
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> LimitRead:
    """Create or replace this category's limit. Idempotent by construction.

    Guard order preserves the existence oracle: a foreign archived category is
    CATEGORY_NOT_FOUND, never CATEGORY_ARCHIVED. System (shared, ``user_id IS
    NULL``) categories are legal targets — they are what a fresh user has — and
    the composite PK means each user's limit on a shared category is their own
    row.
    """
    category = await load_visible_category(session, category_id, user.id)
    if category is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="CATEGORY_NOT_FOUND"
        )
    if category.archived:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="CATEGORY_ARCHIVED",
        )
    if category.kind != CategoryKind.expense.value:
        # OQ-7: a budget caps spending, and an income category has none. Silently
        # accepting one would produce a bar that can never move.
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="CATEGORY_NOT_EXPENSE",
        )
    # Read-only base read (never self-heals a profiles row), stamped once here
    # and left alone by every later read (D15).
    base = await read_base_currency(session, user.id)
    await session.execute(
        pg_insert(CategoryLimit)
        .values(
            user_id=user.id,
            category_id=category_id,
            amount_minor=payload.amount_minor,
            currency=base,
        )
        .on_conflict_do_update(
            index_elements=["user_id", "category_id"],
            set_={
                "amount_minor": payload.amount_minor,
                # A rewrite re-stamps the currency: the user is restating the
                # threshold now, in today's base.
                "currency": base,
                "updated_at": func.now(),
            },
        )
    )
    await session.commit()
    return LimitRead(
        category_id=category_id,
        limit_minor=payload.amount_minor,
        limit_currency=base,
    )


@router.delete(
    "/{category_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    responses=_NOT_FOUND,
)
async def delete_limit(
    category_id: uuid.UUID,
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> None:
    """Remove the limit. The category and its transactions are untouched.

    The load is user_id-scoped, so a foreign limit and a missing one leave by the
    same code path with a byte-identical body (no-oracle).
    """
    row = await session.scalar(
        select(CategoryLimit).where(
            CategoryLimit.user_id == user.id,
            CategoryLimit.category_id == category_id,
        )
    )
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="LIMIT_NOT_FOUND"
        )
    await session.delete(row)
    await session.commit()
