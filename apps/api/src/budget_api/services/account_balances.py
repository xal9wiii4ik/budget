"""Computed account balances — the read-side half of architecture §2.

The balance is NOT a stored column on purpose. Storing it would mean a dual write
on every transaction create / PATCH / DELETE *and* on the two paths that are easy
to forget precisely because they are not ordinary creates: the idempotent
``client_id`` replay and the post-``IntegrityError`` recovery arm, plus the
recurring materializer. One missed path and the number silently disagrees with the
ledger forever. Per-user volumes here are small (the D13 precedent), so summing on
read is both correct-by-construction and cheap.

Money never crosses currencies here: every leg is already denominated in the
currency of the account it touches (a transaction is stamped from its account,
architecture §4; the transfer's target leg carries ``counter_amount_minor`` in the
TARGET account's currency, §3). So this is plain integer arithmetic — no rate
lookup, no exponent crossing, nothing to round.
"""

import uuid

from sqlalchemy import case, func, select, union_all
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.enums import TransactionKind
from budget_api.models import Transaction


async def account_balances(
    session: AsyncSession, user_id: uuid.UUID
) -> dict[uuid.UUID, int]:
    """Net movement per account for ``user_id`` — WITHOUT the starting balance.

    The caller adds ``starting_balance_minor`` from the account rows it already
    holds, and reads a missing key as 0: an account with no movements simply has no
    leg in the union, and inventing a zero row for it here would mean a second query.

    ONE pass over the user's rows: UNION ALL of the two leg shapes, grouped once.
    Correlated per-account subqueries would scan once per account and drag NULL
    arithmetic in behind them.
    """
    # Leg 1 — the row's OWN account: income adds, expense subtracts, and a transfer
    # subtracts exactly like an expense (the money left this account).
    own = select(
        Transaction.account_id.label("account_id"),
        case(
            (
                Transaction.kind == TransactionKind.income.value,
                Transaction.amount_minor,
            ),
            else_=-Transaction.amount_minor,
        ).label("delta"),
    ).where(Transaction.user_id == user_id)
    # Leg 2 — the transfer's TARGET account: what actually landed, in that account's
    # own currency (never a conversion of leg 1).
    incoming = select(
        Transaction.counter_account_id.label("account_id"),
        Transaction.counter_amount_minor.label("delta"),
    ).where(
        Transaction.user_id == user_id,
        Transaction.kind == TransactionKind.transfer.value,
    )
    legs = union_all(own, incoming).subquery()
    rows = (
        await session.execute(
            select(legs.c.account_id, func.sum(legs.c.delta).label("total")).group_by(
                legs.c.account_id
            )
        )
    ).all()
    # Postgres SUM(bigint) is numeric — int() is the same normalization
    # services/tx_totals.py applies to its grouped sums.
    return {account_id: int(total) for account_id, total in rows}
