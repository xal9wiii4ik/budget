"""Read-only profile reads shared by GET handlers (D1's amended services rule).

One home for the "a GET never writes a profile" policy: the summary, the goals
portfolio and the stats endpoints all need the user's base currency and none of
them may self-heal a missing ``profiles`` row (only the writes do — see
``routers/transactions._get_or_create_profile``). Four consumers of a two-line
read is exactly the extraction trigger; the behaviour is unchanged at every one.
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
