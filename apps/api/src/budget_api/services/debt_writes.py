"""The SINGLE writer of debt movements: kind stamping, the lock, the money rules.

Every row with a ``debt_id`` is written here and nowhere else. That is what makes
three invariants hold without a cross-table constraint to hold them:

* **kind is a function of (direction, role)** — ``domain/debts.movement_kind`` is
  called on every insert AND on every edit, and ``direction`` is immutable, so a
  stored row's kind can never go stale;
* **no overpayment** — every movement write takes ``SELECT … FOR UPDATE`` on the
  ``debts`` row BEFORE reading the totals, so two concurrent repayments cannot
  both pass the check (the goal-items advisory-lock idea in its cheapest form);
* **one currency rule for every movement, opening included** — :func:`_amounts`,
  below.

Nothing here raises ``HTTPException``: a service has no status code to raise (the
``StatementApplyError`` precedent). Refusals leave as :class:`DebtWriteError` and
the router maps the code onto a 422. Nothing here commits either — the caller owns
the transaction, which is what lets ``POST /debts`` write the debt and its
principal movement atomically and lets the router keep the post-``IntegrityError``
replay arm.
"""

import uuid
from dataclasses import dataclass
from datetime import date

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.domain.debts import movement_kind
from budget_api.enums import DebtDirection, DebtRole
from budget_api.models import Account, Debt, Transaction
from budget_api.services.debt_reads import movement_totals


class DebtWriteError(Exception):
    """A refusal the router turns into its status code, carrying the string code."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class MovementAmounts:
    """One movement in both currencies: the debt's, and the account's."""

    debt_amount_minor: int
    account_amount_minor: int


def _amounts(
    *,
    debt_currency: str,
    account_currency: str,
    amount_minor: int,
    account_amount_minor: int | None,
) -> MovementAmounts:
    """The ONE currency rule for every debt movement (architecture §Currency).

    ``amount_minor`` is the movement in the DEBT's currency (what the counterparty
    counts as lent or repaid); the account was debited or credited in ITS own
    currency.

    * The two currencies DIFFER ⇒ the account amount is REQUIRED from the client
      (``DEBT_ACCOUNT_AMOUNT_REQUIRED``). The transfer precedent: the rate that
      actually applied is a fact the user knows and a daily rate would be our
      guess, so nothing is converted and no rate snapshot is stored.
    * They are EQUAL ⇒ the server COPIES the amount. A sent value that disagrees
      is refused whole (``DEBT_ACCOUNT_AMOUNT_NOT_APPLICABLE``, the
      ``ACCOUNT_CURRENCY_MISMATCH`` shape) rather than silently restated: a client
      that believes it booked two different numbers must not get a 2xx.
    """
    if debt_currency != account_currency:
        if account_amount_minor is None:
            raise DebtWriteError("DEBT_ACCOUNT_AMOUNT_REQUIRED")
        return MovementAmounts(amount_minor, account_amount_minor)
    if account_amount_minor is not None and account_amount_minor != amount_minor:
        raise DebtWriteError("DEBT_ACCOUNT_AMOUNT_NOT_APPLICABLE")
    return MovementAmounts(amount_minor, amount_minor)


def check_due_on(opened_on: date, due_on: date | None) -> None:
    """ "Give it back by" cannot precede the day the money moved.

    Public because the PATCH route judges the EFFECTIVE pair (moving either date
    is the same illegal row, the deposits rule) and must raise the identical code
    the create path does.
    """
    if due_on is not None and due_on < opened_on:
        raise DebtWriteError("DEBT_DUE_BEFORE_OPENING")


async def _lock(session: AsyncSession, user_id: uuid.UUID, debt_id: uuid.UUID) -> None:
    """Hold the debt row for the rest of this transaction.

    Taken by EVERY movement write before :func:`movement_totals` is read, so two
    concurrent repayments serialize on it instead of both seeing the same
    ``remaining`` and both passing the ceiling check. ``user_id`` is in the
    predicate like everywhere else; the caller has already resolved ownership, so
    a miss here cannot happen and the lock is simply not taken.
    """
    await session.execute(
        select(Debt.id)
        .where(Debt.id == debt_id, Debt.user_id == user_id)
        .with_for_update()
    )


async def _totals(
    session: AsyncSession, user_id: uuid.UUID, debt_id: uuid.UUID
) -> tuple[int, int]:
    """``(principal, repaid)`` in the debt's currency — the READ path's own query."""
    totals = (await movement_totals(session, user_id, [debt_id])).get(debt_id)
    if totals is None:
        return 0, 0
    return totals.principal_minor, totals.repaid_minor


def _movement(
    *,
    user_id: uuid.UUID,
    debt: Debt,
    role: DebtRole,
    account: Account,
    amounts: MovementAmounts,
    occurred_at: date,
    note: str | None,
    client_id: uuid.UUID | None,
) -> Transaction:
    """A debt movement row. Every field the nine CHECKs forbid stays unset.

    ``currency`` is stamped from the ACCOUNT exactly as on every transaction, and
    ``kind`` comes from the pure table — so the ledger reads the movement the same
    way the bank statement does.
    """
    return Transaction(
        user_id=user_id,
        account_id=account.id,
        amount_minor=amounts.account_amount_minor,
        kind=movement_kind(DebtDirection(debt.direction), role).value,
        currency=account.currency,
        occurred_at=occurred_at,
        note=note,
        debt_id=debt.id,
        debt_role=role.value,
        debt_amount_minor=amounts.debt_amount_minor,
        client_id=client_id,
    )


async def create_debt(
    session: AsyncSession,
    user_id: uuid.UUID,
    *,
    direction: DebtDirection,
    counterparty: str,
    currency: str,
    amount_minor: int,
    account: Account,
    opened_on: date,
    account_amount_minor: int | None,
    due_on: date | None,
    note: str | None,
    client_id: uuid.UUID | None,
) -> tuple[Debt, Transaction]:
    """The ``debts`` row AND its principal movement, added to the caller's session.

    Two rows in one transaction (the ``POST /deposits`` shape): a debt without its
    opening movement would be a debt whose amount is nowhere, and the partial
    unique index makes a second principal impossible afterwards.
    """
    check_due_on(opened_on, due_on)
    amounts = _amounts(
        debt_currency=currency,
        account_currency=account.currency,
        amount_minor=amount_minor,
        account_amount_minor=account_amount_minor,
    )
    debt = Debt(
        user_id=user_id,
        direction=direction.value,
        counterparty=counterparty,
        currency=currency,
        due_on=due_on,
        note=note,
    )
    session.add(debt)
    # Flush, not commit: the debt id is needed for the movement's FK, and a debt
    # without its principal must never survive a failure of the second insert.
    await session.flush()
    principal = _movement(
        user_id=user_id,
        debt=debt,
        role=DebtRole.principal,
        account=account,
        amounts=amounts,
        occurred_at=opened_on,
        # The note belongs to the DEBT (it is what the user wrote about the loan);
        # the movement carries none of its own, so editing one never rewrites the
        # other.
        note=None,
        client_id=client_id,
    )
    session.add(principal)
    return debt, principal


async def add_repayment(
    session: AsyncSession,
    user_id: uuid.UUID,
    debt: Debt,
    *,
    amount_minor: int,
    account: Account,
    occurred_at: date,
    account_amount_minor: int | None,
    note: str | None,
    client_id: uuid.UUID | None,
) -> Transaction:
    """One partial repayment, refused when it would overshoot what is left.

    A repayment on a CLOSED debt is the very same refusal (``remaining`` is 0),
    which is why there is no separate ``DEBT_CLOSED`` code: "closed" is not a lock,
    it is the arithmetic saying there is nothing left to repay.
    """
    amounts = _amounts(
        debt_currency=debt.currency,
        account_currency=account.currency,
        amount_minor=amount_minor,
        account_amount_minor=account_amount_minor,
    )
    await _lock(session, user_id, debt.id)
    principal_minor, repaid_minor = await _totals(session, user_id, debt.id)
    if repaid_minor + amounts.debt_amount_minor > principal_minor:
        raise DebtWriteError("DEBT_REPAYMENT_EXCEEDS_REMAINING")
    row = _movement(
        user_id=user_id,
        debt=debt,
        role=DebtRole.repayment,
        account=account,
        amounts=amounts,
        occurred_at=occurred_at,
        note=note,
        client_id=client_id,
    )
    session.add(row)
    return row


async def update_movement(
    session: AsyncSession,
    user_id: uuid.UUID,
    debt: Debt,
    row: Transaction,
    *,
    role: DebtRole,
    amount_minor: int | None,
    account: Account | None,
    occurred_at: date | None,
    account_amount_minor: int | None,
    note: str | None,
    note_sent: bool,
) -> None:
    """Edit a stored movement — the principal's amount, or one repayment's.

    PATCH semantics, judged on the pair the edit will LEAVE BEHIND (the deposits
    and transfers rule): ``None`` means "keep". Moving a movement to an account of
    ANOTHER currency restates what left the account, so the account amount must
    travel in the same request (422 ``AMOUNT_REQUIRED_ON_CURRENCY_CHANGE``, the
    recurring-template precedent) — restamping the currency alone would silently
    redefine the stored integer.

    The lock comes FIRST — before the stored row is re-read and before anything
    effective is derived from it — so every input of the ceiling is post-lock
    state: the row was loaded by the router outside the lock, and SQLAlchemy does
    not expire it on a Core execute, so without the refresh a concurrent edit of
    this very movement that commits in between would leave the subtracted stored
    amount stale and let the two edits sum past the principal. The ceiling is then
    checked on the EFFECTIVE sums, as for a new repayment: raising a repayment
    past what is left is ``DEBT_REPAYMENT_EXCEEDS_REMAINING``, shrinking the
    principal below what is already repaid is ``DEBT_PRINCIPAL_BELOW_REPAID``.
    """
    await _lock(session, user_id, debt.id)
    await session.refresh(row)
    eff_currency = account.currency if account is not None else row.currency
    eff_debt_amount = (
        amount_minor if amount_minor is not None else row.debt_amount_minor
    )
    assert eff_debt_amount is not None  # a debt movement always carries it (CHECK)
    if (
        eff_currency != row.currency
        and eff_currency != debt.currency
        and account_amount_minor is None
    ):
        # The stored integer is minor units of the OLD account's currency;
        # restamping the currency alone would redefine what left the account.
        raise DebtWriteError("AMOUNT_REQUIRED_ON_CURRENCY_CHANGE")
    if account_amount_minor is not None:
        account_amount = account_amount_minor
    elif eff_currency == debt.currency:
        # Equal currencies: the server copies, and a disagreeing sent value was
        # refused by ``_amounts`` — the same answer the create path gives.
        account_amount = None
    else:
        # Cross-currency and the account did not move: the stored amount is still
        # denominated in this very currency, so "omit = keep" applies to it.
        account_amount = row.amount_minor
    amounts = _amounts(
        debt_currency=debt.currency,
        account_currency=eff_currency,
        amount_minor=eff_debt_amount,
        account_amount_minor=account_amount,
    )

    principal_minor, repaid_minor = await _totals(session, user_id, debt.id)
    stored = row.debt_amount_minor or 0
    if role is DebtRole.repayment:
        if repaid_minor - stored + amounts.debt_amount_minor > principal_minor:
            raise DebtWriteError("DEBT_REPAYMENT_EXCEEDS_REMAINING")
    elif amounts.debt_amount_minor < repaid_minor:
        raise DebtWriteError("DEBT_PRINCIPAL_BELOW_REPAID")

    row.debt_amount_minor = amounts.debt_amount_minor
    row.amount_minor = amounts.account_amount_minor
    if account is not None:
        row.account_id = account.id
        row.currency = account.currency  # restamped, as on every account move
    if occurred_at is not None:
        row.occurred_at = occurred_at
    if note_sent:
        row.note = note
    # Re-stamped even though neither direction nor role can change: the kind of a
    # stored movement is DERIVED, and deriving it on every write is what keeps it
    # from ever being an independently editable copy.
    row.kind = movement_kind(DebtDirection(debt.direction), role).value
