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

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.auth import current_active_user
from budget_api.db import get_session
from budget_api.domain.money import SUPPORTED_CURRENCIES
from budget_api.models import Profile, User
from budget_api.models.profile import DEFAULT_BASE_CURRENCY
from budget_api.schemas.profile import ProfileError, ProfileRead, ProfileUpdate
from budget_api.services.profile_reads import get_or_create_profile

router = APIRouter()

# Declared on BOTH routes (the routers/stats.py precedent): this router is
# auth-required end to end and answers {"detail": "Unauthorized"} — the
# ProfileError shape.
#
# It is also load-bearing for the union below: FastAPI only emits a component for
# a model it sees on a `responses` entry, and the anyOf arm is a raw $ref (a
# `"model"` on the SAME response would be merged INTO that schema as a sibling
# $ref and make the generated TS lie about one arm). The older routers get their
# error model registered by a 404; /profile has none, so the honest 401 anchors
# it — verified: without this the export leaves a dangling ProfileError $ref.
_UNAUTHORIZED: dict[int | str, dict[str, object]] = {
    status.HTTP_401_UNAUTHORIZED: {"model": ProfileError}
}
# The honest anyOf union (routers/goals.py precedent): this router now has
# business codes of its own (ProfileError) AND still raises FastAPI's auto
# Pydantic array (a malformed country, a negative income), so declaring only the
# model would suppress the auto arm. PATCH only — GET validates nothing.
_UNPROCESSABLE: dict[int | str, dict[str, object]] = {
    status.HTTP_422_UNPROCESSABLE_CONTENT: {
        "description": "Business rule rejection (string code) or validation error",
        "content": {
            "application/json": {
                "schema": {
                    "anyOf": [
                        {"$ref": "#/components/schemas/ProfileError"},
                        {"$ref": "#/components/schemas/HTTPValidationError"},
                    ]
                }
            }
        },
    }
}


def _serialize(profile: Profile) -> ProfileRead:
    """Row → wire. A PURE function of the row (no session, no joins).

    ``model_validate`` rather than field-by-field construction: ``language`` is a
    two-value ``Literal`` on the wire but a plain ``VARCHAR(2)`` in the row, and
    this is the one place the two meet. The DB CHECK admits exactly the same two
    values, so the re-validation can only ever fail if the column were widened
    without widening the schema — which is precisely when we want it to fail.
    """
    return ProfileRead.model_validate(profile)


@router.get("", response_model=ProfileRead, responses=_UNAUTHORIZED)
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


@router.patch(
    "", response_model=ProfileRead, responses={**_UNAUTHORIZED, **_UNPROCESSABLE}
)
async def update_profile(
    payload: ProfileUpdate,
    user: User = Depends(current_active_user),  # JWT ONLY — settings, not tooling
    session: AsyncSession = Depends(get_session),
) -> ProfileRead:
    """Set/clear the four settings; omitted fields are left untouched.

    ``model_fields_set`` owns the omitted-vs-explicit-null distinction, as
    everywhere else in this codebase: omit keeps the stored value, an explicit null
    clears it back to "not confirmed", a value overwrites. ``base_currency`` is the
    one exception — a NOT NULL column, so its explicit null is a 422 rather than a
    clear (the ``GoalUpdate`` precedent).

    Both refusals fire BEFORE anything is committed, so a rejected PATCH leaves
    the row (and a row this call self-healed into existence) exactly as it was.
    """
    profile = await get_or_create_profile(session, user.id)
    fields = payload.model_fields_set
    # ARM ORDER IS LOAD-BEARING (plan Amendment A1): base_currency is applied
    # FIRST so that a PATCH carrying BOTH a new base and a new income ends with
    # the SENT income — the user re-declaring it in the new currency in one
    # request must win over the switch's clear below.
    if "base_currency" in fields:
        if payload.base_currency is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="BASE_CURRENCY_REQUIRED",
            )
        # Case-sensitive, never normalized — the COUNTRY_PATTERN house rule.
        if payload.base_currency not in SUPPORTED_CURRENCIES:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="CURRENCY_NOT_SUPPORTED",
            )
        if payload.base_currency != profile.base_currency:
            # A1: the declared income carries no currency of its own — it is read
            # in whatever base is stored. Re-denominating 250000 RUB as 2500.00
            # BYN would be a ~30x-wrong "declared" basis wearing a working
            # feature's face, so an ACTUAL switch clears it and the web asks for
            # the number again. A same-value PATCH is not a switch and keeps it.
            profile.monthly_income_minor = None
        profile.base_currency = payload.base_currency
    if "monthly_income_minor" in fields:
        profile.monthly_income_minor = payload.monthly_income_minor
    if "country" in fields:
        profile.country = payload.country
    if "language" in fields:
        profile.language = payload.language
    await session.commit()
    await session.refresh(profile)
    return _serialize(profile)
