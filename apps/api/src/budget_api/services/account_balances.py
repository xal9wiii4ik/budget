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

TWO readers, ONE definition of the legs (``_legs``): the whole-list one behind
``GET /accounts`` and the single-account, date-cut one the statement import stamps
after an apply (``account_balance_as_of``, pdf-reconcile D-B1). They must not be
two expressions — "the balance" appearing twice with two slightly different rules
is exactly how a screen and a reconciliation report start contradicting each other.
"""

import uuid
from datetime import date

from sqlalchemy import case, func, select, union_all
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import Subquery

from budget_api.enums import TransactionKind
from budget_api.models import Account, Transaction


def _legs(user_id: uuid.UUID, *, as_of: date | None = None) -> Subquery:
    """THE definition of "what moved on an account", written once.

    Both readers below go through it, so the number ``GET /accounts`` publishes and
    the number the statement import holds the bank's closing balance against can
    never drift into two different meanings of the word "balance".

    * Leg 1 — the row's OWN account: income adds, expense subtracts, and a transfer
      subtracts exactly like an expense (the money left this account). A DEBT
      movement is an ordinary expense/income row and is signed here with no rule of
      its own — it moved real money on a real account, unlike in the money
      aggregates of ``tx_totals.py``, which cut those rows out.
    * Leg 2 — the transfer's TARGET account: what actually landed, in that
      account's own currency (never a conversion of leg 1, architecture §3).

    ``as_of`` cuts BOTH legs at the same date. ``occurred_at`` is a ``Date``
    column, so ``<= as_of`` is exact: a row dated ``as_of`` is in, one dated the
    next day is out.
    """
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
    incoming = select(
        Transaction.counter_account_id.label("account_id"),
        Transaction.counter_amount_minor.label("delta"),
    ).where(
        Transaction.user_id == user_id,
        Transaction.kind == TransactionKind.transfer.value,
    )
    if as_of is not None:
        own = own.where(Transaction.occurred_at <= as_of)
        incoming = incoming.where(Transaction.occurred_at <= as_of)
    return union_all(own, incoming).subquery()


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
    legs = _legs(user_id)
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


async def account_balance_as_of(
    session: AsyncSession, user_id: uuid.UUID, account_id: uuid.UUID, as_of: date
) -> int:
    """The balance ``GET /accounts`` would show for this account on ``as_of``.

    The same two legs (``_legs``) and the same ``starting_balance_minor`` addition
    the list route performs, with one date cutoff — so "the app's balance at the
    end of the statement period" is the SAME word as the balance on the accounts
    screen, not a second definition that could disagree with it (pdf-reconcile
    D-B1).

    A setup fact and not a movement: ``starting_balance_minor`` is dated nowhere
    and therefore counts whatever ``as_of`` is — exactly as it does in the list,
    where a deposit's opening body is a starting balance and not a back-dated
    transfer.

    An account id that is not this user's answers 0 and nothing else: this is a
    stamp inside a write whose own gates already resolved the account, never an
    existence probe.
    """
    legs = _legs(user_id, as_of=as_of)
    moved = await session.scalar(
        select(func.coalesce(func.sum(legs.c.delta), 0)).where(
            legs.c.account_id == account_id
        )
    )
    starting = await session.scalar(
        select(Account.starting_balance_minor).where(
            Account.id == account_id, Account.user_id == user_id
        )
    )
    return int(starting or 0) + int(moved or 0)
