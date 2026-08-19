"""Shared account-visibility helper (the ``category_access.py`` shape, no system arm).

Top-level neutral module for the same reason ``category_access.py`` is one: it
imports ``models`` and is imported by routers, so there is no import cycle.

Accounts have no system rows — every account belongs to exactly one user — so
there is no visibility *predicate* to share, only the single-code-path load. That
load is the whole point: a foreign account and a missing one resolve through ONE
query to ONE ``None``, so the ``404 ACCOUNT_NOT_FOUND`` they produce is
byte-identical and tells an attacker nothing about which ids exist. The
transactions write path relies on this for BOTH ``account_id`` and
``counter_account_id`` — a transfer aimed at someone else's account must be
indistinguishable from one aimed at nothing.
"""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.models import Account


async def load_own_account(
    session: AsyncSession, account_id: uuid.UUID, user_id: uuid.UUID
) -> Account | None:
    """The caller's own account. Foreign/missing → None (one code path, no-oracle).

    Archived rows ARE returned: "exists but archived" is a different answer from
    "does not exist", and the caller decides. Keeping the archived filter OUT of
    this query is what lets the guard order stay ``NOT_FOUND`` before ``ARCHIVED``
    — a foreign archived account must answer NOT_FOUND, never ARCHIVED.
    """
    return await session.scalar(
        select(Account).where(Account.id == account_id, Account.user_id == user_id)
    )
