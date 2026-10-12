"""Debt arithmetic — pure, no IO (debts architecture §Decisions).

Four functions and no currency math at all: every number here is already in the
DEBT's own currency (``transactions.debt_amount_minor``), because that is what the
writer stores on every movement. Converting a debt to the base currency is a READ
concern and lives in ``services/debt_reads.debt_summary``.

:func:`movement_kind` is the one place the sign of debt money is decided. There is
no cross-table CHECK that can hold it (the direction lives on ``debts``, the kind
on ``transactions``), so the guard is this pure function + an IMMUTABLE
``direction`` + a single writer (``services/debt_writes.py``) that calls it on
every insert and on every edit. The four cases are pinned by a test.

Remaining, status and ``closed_on`` are DERIVED and stored nowhere: a stored flag
would have to be recomputed by every movement write AND delete, and deleting a
repayment must simply reopen the debt — which here it does, by arithmetic.
"""

from datetime import date

from budget_api.enums import DebtDirection, DebtRole, DebtStatus, TransactionKind


def movement_kind(direction: DebtDirection, role: DebtRole) -> TransactionKind:
    """What a debt movement IS to the ledger — the four-case table.

    * lent + principal → ``expense``: the money left the account.
    * lent + repayment → ``income``: it came back.
    * borrowed + principal → ``income``: the loan landed on the account.
    * borrowed + repayment → ``expense``: paying it back.

    So ``services/account_balances.py`` signs a debt movement with no new rule,
    while ``services/tx_totals.py`` keeps it out of every income/expense
    aggregate by ``debt_id IS NULL`` — the money moves, the statistics do not.
    """
    opening = role is DebtRole.principal
    if direction is DebtDirection.lent:
        return TransactionKind.expense if opening else TransactionKind.income
    return TransactionKind.income if opening else TransactionKind.expense


def remaining(principal_minor: int, repaid_minor: int) -> int:
    """What is still owed, in the debt's currency.

    Never clamped and never negative in practice: every write path refuses the
    overpayment that would make it so (422 ``DEBT_REPAYMENT_EXCEEDS_REMAINING`` /
    ``DEBT_PRINCIPAL_BELOW_REPAID``) under a row lock, so a negative value here
    would mean the lock was bypassed — it is served as it computes rather than
    hidden behind a ``max(0, …)``.
    """
    return principal_minor - repaid_minor


def status_of(remaining_minor: int) -> DebtStatus:
    """``closed`` exactly when nothing is left to give back."""
    return DebtStatus.closed if remaining_minor == 0 else DebtStatus.open


def closed_on(remaining_minor: int, last_repayment_on: date | None) -> date | None:
    """The date the debt was settled — the LAST repayment's date, or None while open.

    Read off the movements rather than stamped at the moment the remainder hit
    zero: a back-dated repayment, a corrected amount and a deleted repayment all
    move this date (or remove it) with no write path to remember.
    """
    if status_of(remaining_minor) is DebtStatus.open:
        return None
    return last_repayment_on
