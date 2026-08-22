"""Profile reads shared across routers (D1's amended services rule).

One home for the "a GET never writes a profile" policy: the summary, the goals
portfolio, the stats endpoints and ``GET /profile`` all need the user's settings
and none of them may self-heal a missing ``profiles`` row. The WRITE half of that
policy lives here too since S1 — ``get_or_create_profile`` self-heals and is used
only by handlers that commit anyway (``POST``/``PATCH /transactions``, ``PATCH
/profile``). It moved out of ``routers/transactions.py`` at its second consumer,
the same trigger that extracted ``tx_totals``; behaviour is unchanged.
"""

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.models import Profile
from budget_api.models.profile import DEFAULT_BASE_CURRENCY


async def read_base_currency(session: AsyncSession, user_id: uuid.UUID) -> str:
    """The user's base currency, or ``DEFAULT_BASE_CURRENCY`` when profile-less.

    Never writes: a pre-1.2 user without a profiles row reads as the default and
    the row is still absent afterwards.
    """
    profile = await session.get(Profile, user_id)
    return profile.base_currency if profile is not None else DEFAULT_BASE_CURRENCY


async def get_or_create_profile(session: AsyncSession, user_id: uuid.UUID) -> Profile:
    """Self-healing profile read (1.2 §6): a pre-1.2 user may lack a profiles row.

    Called ONLY from handlers that commit anyway — the two transaction writes (the
    snapshot decision table needs the base currency) and ``PATCH /profile`` — so a
    self-healed row persists atomically with whatever that request was doing. The
    flush is deliberate: it makes the row visible to the rest of the request without
    committing on its own, so a later 422 discards it with everything else.

    GET handlers must NOT call this (a GET stays read-only); they fall back through
    ``read_base_currency`` above.
    """
    profile = await session.get(Profile, user_id)
    if profile is None:
        profile = Profile(user_id=user_id, base_currency=DEFAULT_BASE_CURRENCY)
        session.add(profile)
        await session.flush()  # persist within the same tx; commit rides the caller
    return profile
