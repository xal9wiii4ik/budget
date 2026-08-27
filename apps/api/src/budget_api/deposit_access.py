"""Shared deposit-visibility helper — the ``account_access.py`` shape, verbatim.

Top-level neutral module for the same reason its two siblings are: it imports
``models`` and is imported by a router, so there is no cycle.

Deposits have no system rows, so there is no visibility *predicate* to share, only
the single-code-path load — which is the whole point. A foreign deposit and a
missing one resolve through ONE query to ONE ``None``, so the
``404 DEPOSIT_NOT_FOUND`` they produce is byte-identical and tells an attacker
nothing about which ids exist.
"""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.models import Deposit


async def load_own_deposit(
    session: AsyncSession, deposit_id: uuid.UUID, user_id: uuid.UUID
) -> Deposit | None:
    """The caller's own deposit. Foreign/missing → None (one code path, no-oracle).

    Archived rows ARE returned: "exists but archived" is a different answer from
    "does not exist", and the caller decides. Keeping the archived filter OUT of
    this query is what lets the router's guard order stay ``NOT_FOUND`` before
    ``ARCHIVED`` — a foreign archived deposit must answer NOT_FOUND, never
    DEPOSIT_ARCHIVED.
    """
    return await session.scalar(
        select(Deposit).where(Deposit.id == deposit_id, Deposit.user_id == user_id)
    )
