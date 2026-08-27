"""Assembling what a deposit LOOKS like on read — the three computed numbers.

A ``deposits`` row on its own says almost nothing a user wants: the body lives on
the hidden account, the interest is not stored at all, and both are per-request
computations. This module is where the row, its account and its money meet, in a
FIXED number of queries — three for one deposit and three for two hundred:

1. the accounts of the deposits being read (one ``IN`` select);
2. every account's net movement (``services/account_balances.py``, one grouped
   query for the whole user, exactly as ``GET /accounts`` does it);
3. every transfer leg touching those accounts, as interest-timeline entries (one
   ``UNION ALL`` select).

Doing 2 and 3 per deposit would be the N+1 the accounts scope already refused
once. The alternative — a stored ``accrued`` column — would need a dual write on
every transfer, every back-dated edit and every day that passes; the day that
passes is the one no write path can cover, which is why interest is computed and
only the manual anchor is stored.

The interest timeline is seeded with ``(opened_on, starting_balance_minor)``
(AMENDMENT §1) and then follows the ledger: this module is the ONLY place those
two sources are joined, so the number in the response cannot drift from the
number in the account.
"""

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date

from sqlalchemy import case, select, union_all
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.domain.deposits import (
    AccrualInput,
    TimelineEntry,
    accrued_minor,
    after_tax_minor,
)
from budget_api.enums import DepositCapitalization, TransactionKind
from budget_api.models import Account, Deposit, Transaction
from budget_api.services.account_balances import account_balances


@dataclass(frozen=True)
class DepositView:
    """One deposit plus everything computed about it, ready for serialization."""

    deposit: Deposit
    account: Account
    balance_minor: int
    accrued_minor: int
    accrued_after_tax_minor: int | None


async def _transfer_timelines(
    session: AsyncSession, user_id: uuid.UUID, account_ids: Sequence[uuid.UUID]
) -> dict[uuid.UUID, list[TimelineEntry]]:
    """Every leg touching ``account_ids``, as ``(date, signed delta)`` per account.

    The same two leg shapes as ``services/account_balances.py`` — and deliberately
    the same sign rules, so the timeline the interest is computed over and the
    balance shown next to it are two readings of ONE ledger. Only the DATE is added
    (``occurred_at``): interest cares when the money arrived, a balance does not.

    Rows are not filtered to transfers on the outgoing leg: the routers refuse
    expense/income on a deposit account (422 ``DEPOSIT_ACCOUNT_TRANSFER_ONLY``), but
    a read must describe what the ledger actually holds rather than assert what it
    should hold.
    """
    if not account_ids:
        return {}
    own = select(
        Transaction.account_id.label("account_id"),
        Transaction.occurred_at.label("on"),
        case(
            (
                Transaction.kind == TransactionKind.income.value,
                Transaction.amount_minor,
            ),
            else_=-Transaction.amount_minor,
        ).label("delta"),
    ).where(Transaction.user_id == user_id, Transaction.account_id.in_(account_ids))
    incoming = select(
        Transaction.counter_account_id.label("account_id"),
        Transaction.occurred_at.label("on"),
        Transaction.counter_amount_minor.label("delta"),
    ).where(
        Transaction.user_id == user_id,
        Transaction.kind == TransactionKind.transfer.value,
        Transaction.counter_account_id.in_(account_ids),
    )
    legs = union_all(own, incoming).subquery()
    rows = (
        await session.execute(
            select(legs.c.account_id, legs.c.on, legs.c.delta).order_by(legs.c.on)
        )
    ).all()
    timelines: dict[uuid.UUID, list[TimelineEntry]] = {}
    for account_id, on, delta in rows:
        timelines.setdefault(account_id, []).append(
            TimelineEntry(on=on, delta_minor=int(delta))
        )
    return timelines


async def deposit_views(
    session: AsyncSession,
    user_id: uuid.UUID,
    deposits: Sequence[Deposit],
    *,
    today: date,
) -> list[DepositView]:
    """Views for ``deposits``, in the given order. Three queries, whatever the count.

    ``today`` is a parameter, never ``date.today()`` read in here: the clock is the
    router's business, and a pure ``as_of`` is what makes the whole accrual chain
    testable at a fixed date.
    """
    if not deposits:
        return []
    account_ids = [deposit.account_id for deposit in deposits]
    accounts = {
        account.id: account
        for account in (
            await session.scalars(
                # user_id in the predicate as well as the id list: every query in
                # this codebase is user-scoped, and a deposit row is not a licence
                # to read an account row.
                select(Account).where(
                    Account.id.in_(account_ids), Account.user_id == user_id
                )
            )
        ).all()
    }
    balances = await account_balances(session, user_id)
    timelines = await _transfer_timelines(session, user_id, account_ids)

    views: list[DepositView] = []
    for deposit in deposits:
        account = accounts[deposit.account_id]
        # The opening body is a setup fact of the ACCOUNT (AMENDMENT §1), so it
        # enters the timeline dated on the day the deposit was opened — which is
        # what makes a year-old deposit show a year of interest on its first read.
        timeline = [
            TimelineEntry(
                on=deposit.opened_on, delta_minor=account.starting_balance_minor
            ),
            *timelines.get(account.id, ()),
        ]
        override = (
            None
            if deposit.accrued_override_as_of is None
            or deposit.accrued_override_minor is None
            else (deposit.accrued_override_as_of, deposit.accrued_override_minor)
        )
        gross = accrued_minor(
            AccrualInput(
                rate_percent=deposit.rate_percent,
                capitalization=DepositCapitalization(deposit.capitalization),
                opened_on=deposit.opened_on,
                term_end=deposit.term_end,
                timeline=timeline,
                as_of=today,
                override=override,
            )
        )
        views.append(
            DepositView(
                deposit=deposit,
                account=account,
                balance_minor=account.starting_balance_minor
                + balances.get(account.id, 0),
                accrued_minor=gross,
                accrued_after_tax_minor=after_tax_minor(
                    gross, deposit.tax_rate_percent
                ),
            )
        )
    return views
