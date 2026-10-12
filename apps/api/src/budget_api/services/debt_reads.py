"""What a debt LOOKS like on read: its principal row, its repayments, its summary.

A ``debts`` row on its own says nothing about money — the principal IS the opening
movement, the repayments are more movements, and ``remaining``/``status``/
``closed_on`` are arithmetic over them (``domain/debts.py``). This module is where
the row and its movements meet, in a FIXED number of queries — two for one debt
and two for two hundred (the ``deposit_reads`` rule):

1. the ``debts`` rows INNER JOINed to their ``principal`` movement, which is where
   ``opened_on``, the account and the account-currency amount come from;
2. :func:`movement_totals` — ONE grouped pass over those debts' movements.

The join is INNER on purpose: a debt without its principal row is unrepresentable
(``POST /debts`` writes both in one transaction, ``DELETE /transactions`` refuses
a debt movement, and the statement replace spares them), so a debt that lost it
would be corrupt data rather than an empty state to render.

:func:`movement_totals` is the SINGLE definition of per-debt money, read by the
list, the detail, the summary, the push family AND the write guards in
``services/debt_writes.py`` — so the number a user is shown and the number an
overpayment is refused against cannot disagree. The arithmetic on top of it is
``domain/debts``, never SQL: one definition of "remaining", in Python.
"""

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.domain.debts import closed_on, remaining, status_of
from budget_api.domain.fx import convert_minor
from budget_api.enums import DebtDirection, DebtRole, DebtStatus
from budget_api.models import Debt, Transaction
from budget_api.services.fx_lookup import lookup_rate
from budget_api.services.profile_reads import read_base_currency

#: Nearest-previous rate per currency pair, resolved at most once per request —
#: the ``services/goal_plan_reads.py`` cache, same shape and same reason (a user
#: with forty USD debts must not cost forty identical lookups).
_RateCache = dict[tuple[str, str], Decimal | None]

_PRINCIPAL = DebtRole.principal.value
_REPAYMENT = DebtRole.repayment.value


@dataclass(frozen=True)
class MovementTotals:
    """Per-debt money, all of it in the DEBT's own currency."""

    principal_minor: int
    repaid_minor: int
    repayments_count: int
    last_repayment_on: date | None


@dataclass(frozen=True)
class DebtView:
    """One debt plus everything computed about it, ready for serialization."""

    debt: Debt
    #: The opening movement. Carries the account the money moved on, the date the
    #: debt was opened and the amount in the ACCOUNT's currency.
    principal: Transaction
    totals: MovementTotals
    remaining_minor: int
    status: DebtStatus
    closed_on: date | None


@dataclass(frozen=True)
class DebtSummary:
    """The two headline figures of ``GET /debts``, in the user's base currency."""

    base_currency: str
    owed_to_me_minor: int
    i_owe_minor: int
    #: OPEN debts of that side left OUT of the sum because their currency has no
    #: rate to the base currency. Counted per side, never summed as zero (D9).
    owed_to_me_unconverted_count: int
    i_owe_unconverted_count: int


async def movement_totals(
    session: AsyncSession, user_id: uuid.UUID, debt_ids: Sequence[uuid.UUID]
) -> dict[uuid.UUID, MovementTotals]:
    """ONE grouped pass over the movements of ``debt_ids``.

    ``user_id`` is in the predicate as well as the id list: every query in this
    codebase is user-scoped, and holding a debt id is not a licence to read
    transactions.

    A debt with no repayments yet has no repayment rows at all, so the two sums
    are ``COALESCE``d to 0 — ``remaining`` must be the principal, never NULL.
    """
    if not debt_ids:
        return {}
    amount = Transaction.debt_amount_minor
    rows = (
        await session.execute(
            select(
                Transaction.debt_id,
                func.coalesce(
                    func.sum(amount).filter(Transaction.debt_role == _PRINCIPAL), 0
                ),
                func.coalesce(
                    func.sum(amount).filter(Transaction.debt_role == _REPAYMENT), 0
                ),
                func.count().filter(Transaction.debt_role == _REPAYMENT),
                func.max(Transaction.occurred_at).filter(
                    Transaction.debt_role == _REPAYMENT
                ),
            )
            .where(
                Transaction.user_id == user_id,
                Transaction.debt_id.in_(debt_ids),
            )
            .group_by(Transaction.debt_id)
        )
    ).all()
    return {
        debt_id: MovementTotals(
            principal_minor=int(principal),
            repaid_minor=int(repaid),
            repayments_count=int(count),
            last_repayment_on=last_on,
        )
        for debt_id, principal, repaid, count, last_on in rows
    }


def _view(debt: Debt, principal: Transaction, totals: MovementTotals) -> DebtView:
    left = remaining(totals.principal_minor, totals.repaid_minor)
    return DebtView(
        debt=debt,
        principal=principal,
        totals=totals,
        remaining_minor=left,
        status=status_of(left),
        closed_on=closed_on(left, totals.last_repayment_on),
    )


async def debt_views(
    session: AsyncSession,
    user_id: uuid.UUID,
    *,
    debt_id: uuid.UUID | None = None,
) -> list[DebtView]:
    """The user's debts (or one of them), newest first, with their money computed.

    Archive-inclusive by nature: there is no archived flag and no ``?status=`` —
    ALL debts come back and the client splits them into "owed to me", "I owe" and
    "closed" (architecture §Read models). A list that hid closed debts would hide
    the history the user asked to be able to look at.
    """
    joined = (
        select(Debt, Transaction)
        .join(
            Transaction,
            (Transaction.debt_id == Debt.id)
            & (Transaction.debt_role == _PRINCIPAL)
            & (Transaction.user_id == user_id),
        )
        .where(Debt.user_id == user_id)
        # Newest first, id last so the order is total and stable (the accounts
        # rule: names and dates are not unique).
        .order_by(Debt.created_at.desc(), Debt.id)
    )
    if debt_id is not None:
        joined = joined.where(Debt.id == debt_id)
    pairs = [(debt, principal) for debt, principal in (await session.execute(joined))]
    totals = await movement_totals(session, user_id, [debt.id for debt, _ in pairs])
    return [_view(debt, principal, totals[debt.id]) for debt, principal in pairs]


async def debt_repayments(
    session: AsyncSession, user_id: uuid.UUID, debt_id: uuid.UUID
) -> list[Transaction]:
    """One debt's repayment rows, oldest first — the detail's embedded history.

    Embedded rather than a route of its own: a debt has a handful of repayments,
    so one request serves the whole screen (architecture §Read models).
    """
    return list(
        (
            await session.scalars(
                select(Transaction)
                .where(
                    Transaction.user_id == user_id,
                    Transaction.debt_id == debt_id,
                    Transaction.debt_role == _REPAYMENT,
                )
                .order_by(
                    Transaction.occurred_at, Transaction.created_at, Transaction.id
                )
            )
        ).all()
    )


async def _rate(
    session: AsyncSession,
    cache: _RateCache,
    from_currency: str,
    to_currency: str,
    on_date: date,
) -> Decimal | None:
    """Nearest-previous rate, resolved at most ONCE per currency pair per call."""
    key = (from_currency, to_currency)
    if key not in cache:
        found = await lookup_rate(session, from_currency, to_currency, on_date)
        cache[key] = None if found is None else found.rate
    return cache[key]


async def debt_summary(
    session: AsyncSession,
    user_id: uuid.UUID,
    views: Sequence[DebtView],
    *,
    today: date,
) -> DebtSummary:
    """ "They owe me X, I owe Y" in the base currency — the server's own arithmetic.

    OPEN debts only: a closed debt's remainder is 0 and would contribute nothing
    but a rate lookup. Each side is summed in the user's base currency at TODAY's
    nearest-previous rate (never the opening date's: this is what is outstanding
    now, not what it was worth then), and a debt whose currency has no rate is
    EXCLUDED from its side's sum and counted — the exclude-and-flag rule, per side,
    so one rateless USD debt cannot make the whole pair look understated.
    """
    base = await read_base_currency(session, user_id)
    cache: _RateCache = {}
    sums = {DebtDirection.lent: 0, DebtDirection.borrowed: 0}
    unconverted = {DebtDirection.lent: 0, DebtDirection.borrowed: 0}
    for view in views:
        if view.status is DebtStatus.closed:
            continue
        side = DebtDirection(view.debt.direction)
        currency = view.debt.currency
        if currency == base:
            sums[side] += view.remaining_minor
            continue
        rate = await _rate(session, cache, currency, base, today)
        if rate is None:
            unconverted[side] += 1
            continue
        sums[side] += convert_minor(view.remaining_minor, currency, base, rate)
    return DebtSummary(
        base_currency=base,
        owed_to_me_minor=sums[DebtDirection.lent],
        i_owe_minor=sums[DebtDirection.borrowed],
        owed_to_me_unconverted_count=unconverted[DebtDirection.lent],
        i_owe_unconverted_count=unconverted[DebtDirection.borrowed],
    )


async def read_upcoming_due(
    session: AsyncSession,
    user_id: uuid.UUID,
    *,
    today: date,
    through: date,
) -> list[str]:
    """Counterparties of OPEN debts due inside ``[today, through]`` — NAMES only.

    The push digest's fourth family (architecture §"Push + coming up"). It returns
    strings and nothing else: ``domain/push_digest.DigestInput`` has no amount
    member at all, and a helper that handed one over would be the first step to
    putting money on a lock screen.

    "Soon" is the SAME inclusive window the other three families use — no second
    definition of soon — and the order is ``due_on`` then ``created_at``, the key
    the other widgets tie-break on.
    """
    due: list[tuple[date, datetime, uuid.UUID, str]] = []
    for view in await debt_views(session, user_id):
        due_on = view.debt.due_on
        if due_on is None or not (today <= due_on <= through):
            continue
        if view.status is not DebtStatus.open:
            continue
        due.append((due_on, view.debt.created_at, view.debt.id, view.debt.counterparty))
    due.sort(key=lambda row: (row[0], row[1], row[2]))
    return [name for *_, name in due]
