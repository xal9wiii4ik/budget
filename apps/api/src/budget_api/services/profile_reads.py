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
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.models import Profile
from budget_api.models.profile import DEFAULT_BASE_CURRENCY


@dataclass(frozen=True)
class ProfileSettings:
    """The read-only half of a profile row, resolved to defaults when absent."""

    base_currency: str
    #: The user's DECLARED monthly income, in ``base_currency`` (it carries no
    #: currency of its own — see schemas/profile.py). ``None`` = never declared,
    #: or cleared by a base switch.
    monthly_income_minor: int | None


async def read_profile_settings(
    session: AsyncSession, user_id: uuid.UUID
) -> ProfileSettings:
    """Both settings the read paths need, in ONE ``session.get``.

    Never writes: a pre-1.2 user without a profiles row reads as the defaults and
    the row is still absent afterwards. Exists because the goals assembler needs
    the base currency AND the declared income together (the free-balance basis,
    D2) and two separate reads would be two round-trips of the same row.
    """
    profile = await session.get(Profile, user_id)
    if profile is None:
        return ProfileSettings(
            base_currency=DEFAULT_BASE_CURRENCY, monthly_income_minor=None
        )
    return ProfileSettings(
        base_currency=profile.base_currency,
        monthly_income_minor=profile.monthly_income_minor,
    )


async def read_base_currency(session: AsyncSession, user_id: uuid.UUID) -> str:
    """The user's base currency, or ``DEFAULT_BASE_CURRENCY`` when profile-less.

    The narrow read its five callers want, expressed through the one above so the
    "a GET never writes a profile" policy has a single implementation.
    """
    return (await read_profile_settings(session, user_id)).base_currency


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
