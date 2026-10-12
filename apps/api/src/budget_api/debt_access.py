"""Shared debt-visibility helpers — the ``deposit_access.py`` shape, verbatim.

Top-level neutral module for the same reason its siblings are: it imports
``models`` and is imported by a router, so there is no cycle.

Debts have no system rows, so there is no visibility *predicate* to share, only
the single-code-path loads — which is the whole point. A foreign debt and a
missing one resolve through ONE query to ONE ``None``, so the ``404
DEBT_NOT_FOUND`` they produce is byte-identical and tells an attacker nothing
about which ids exist. The repayment load works the same way at the second level
(the ``IMPORT_NOT_FOUND`` precedent): a foreign debt, a missing debt, a repayment
of someone else's debt and a plain typo are ONE answer.
"""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.enums import DebtRole
from budget_api.models import Debt, Transaction


async def load_own_debt(
    session: AsyncSession, debt_id: uuid.UUID, user_id: uuid.UUID
) -> Debt | None:
    """The caller's own debt. Foreign/missing → None (one code path, no-oracle).

    Closed debts ARE returned: "closed" is derived from the movements and is a
    filter state, not a lock — editing the note, the due date or the counterparty
    of a settled debt is allowed (architecture §"Remaining, status, closed").
    """
    return await session.scalar(
        select(Debt).where(Debt.id == debt_id, Debt.user_id == user_id)
    )


async def load_own_repayment(
    session: AsyncSession,
    debt_id: uuid.UUID,
    repayment_id: uuid.UUID,
    user_id: uuid.UUID,
) -> Transaction | None:
    """One repayment OF THIS DEBT. Everything else → None → the same 404.

    ``debt_role = 'repayment'`` is part of the filter, so the debt's principal row
    cannot be addressed through the repayment routes — its amount is edited
    through ``PATCH /debts/{id}``, where the overpayment rule that guards it lives.
    """
    return await session.scalar(
        select(Transaction).where(
            Transaction.id == repayment_id,
            Transaction.debt_id == debt_id,
            Transaction.user_id == user_id,
            Transaction.debt_role == DebtRole.repayment.value,
        )
    )
