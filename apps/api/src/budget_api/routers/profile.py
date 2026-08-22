"""The user's own settings row — ``GET`` / ``PATCH /profile`` (S1).

**JWT-ONLY, on purpose** (the ``routers/tokens.py`` precedent): both handlers
depend on ``current_active_user`` imported straight from ``auth.py``, never on
``current_user_jwt_or_pat``. Settings are a browser-session concern — the MCP
package books money, it does not pick the UI language — so this router is simply
not part of the PAT surface: the allowlist gate lives INSIDE the PAT dependency
and is never reached from here. A ``bgt_pat_`` bearer fails the JWT decode and
gets a plain **401** — one barrier, not two, and no ``PAT_ALLOWLIST`` entry to
maintain.

The read/write asymmetry is the other deliberate part: ``GET`` never writes
(``read_profile`` below resolves a missing row to server defaults and leaves the
table alone), while ``PATCH`` self-heals through ``get_or_create_profile`` — it
commits anyway, so a healed row rides that commit. That is the same split the
transactions router has used since 1.2, spelled here for a router where BOTH
halves live next to each other.
"""

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.auth import current_active_user
from budget_api.db import get_session
from budget_api.models import Profile, User
from budget_api.models.profile import DEFAULT_BASE_CURRENCY
from budget_api.schemas.profile import ProfileRead, ProfileUpdate
from budget_api.services.profile_reads import get_or_create_profile

router = APIRouter()


def _serialize(profile: Profile) -> ProfileRead:
    """Row → wire. A PURE function of the row (no session, no joins).

    ``model_validate`` rather than field-by-field construction: ``language`` is a
    two-value ``Literal`` on the wire but a plain ``VARCHAR(2)`` in the row, and
    this is the one place the two meet. The DB CHECK admits exactly the same two
    values, so the re-validation can only ever fail if the column were widened
    without widening the schema — which is precisely when we want it to fail.
    """
    return ProfileRead.model_validate(profile)


@router.get("", response_model=ProfileRead)
async def read_profile(
    user: User = Depends(current_active_user),  # JWT ONLY — settings, not tooling
    session: AsyncSession = Depends(get_session),
) -> ProfileRead:
    """The caller's settings; a user without a row reads as defaults, unwritten.

    Deliberately NOT self-healing (the ``read_base_currency`` contract): a GET that
    inserted a row would make a plain page load a write, and the defaults it would
    persist are exactly the ones returned here anyway.
    """
    profile = await session.get(Profile, user.id)
    if profile is None:
        return ProfileRead(
            base_currency=DEFAULT_BASE_CURRENCY,
            monthly_income_minor=None,
            country=None,
            language=None,
        )
    return _serialize(profile)


@router.patch("", response_model=ProfileRead)
async def update_profile(
    payload: ProfileUpdate,
    user: User = Depends(current_active_user),  # JWT ONLY — settings, not tooling
    session: AsyncSession = Depends(get_session),
) -> ProfileRead:
    """Set/clear ``country`` and ``language``; omitted fields are left untouched.

    ``model_fields_set`` owns the omitted-vs-explicit-null distinction, as
    everywhere else in this codebase: omit keeps the stored value, an explicit null
    clears it back to "not confirmed", a value overwrites. ``base_currency`` and
    ``monthly_income_minor`` are not writable here (see schemas/profile.py).
    """
    profile = await get_or_create_profile(session, user.id)
    fields = payload.model_fields_set
    if "country" in fields:
        profile.country = payload.country
    if "language" in fields:
        profile.language = payload.language
    await session.commit()
    await session.refresh(profile)
    return _serialize(profile)
