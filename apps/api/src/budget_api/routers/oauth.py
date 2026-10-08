"""Consent and "Connected AI applications" — the four routes a BROWSER calls.

**JWT-ONLY, all four**, and that is the whole security posture of this module: each
handler depends on ``current_active_user`` imported straight from ``auth.py`` (the
``routers/tokens.py`` precedent) and none carries an MCP marker, so a token is
refused twice over — a ``bgt_`` bearer fails the JWT decode, and no ``/oauth`` pair
is in the derived PAT allowlist (pinned by ``NEVER_PAT`` in
``tests/test_pat_auth.py``). An AI app that could approve its own consent, or
revoke the grant that limits it, would be an escalation ladder from a leaked token
to full account access.

The RFC endpoints (``/oauth/authorize``, ``/oauth/token``, ``/oauth/register``,
the two well-known documents) are Starlette routes OUTSIDE this contract —
``oauth/routes.py``.

Two no-oracle 404s, one code path each: ``OAUTH_REQUEST_NOT_FOUND`` collapses
unknown / expired / already-decided, and ``OAUTH_APP_NOT_FOUND`` collapses
unknown / foreign / already-revoked / "that id is a plain PAT, not a grant". The
last one is what keeps ``/tokens`` and ``/oauth/apps`` from cross-listing: each
route sees only its own kind of row (``routers/tokens.py`` filters the mirror
image).
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.auth import current_active_user
from budget_api.config import Settings
from budget_api.db import get_session
from budget_api.enums import PatScope
from budget_api.models import OAuthClient, PersonalAccessToken, User
from budget_api.oauth.consent import decide, read_request
from budget_api.schemas.oauth import (
    OAuthAppList,
    OAuthAppRead,
    OAuthDecision,
    OAuthDecisionResult,
    OAuthError,
    OAuthRequestRead,
)

router = APIRouter()

# Mirrors routers/tokens.py: stable UPPER_SNAKE codes carried in {"detail": ...}.
_NOT_FOUND: dict[int | str, dict[str, object]] = {
    status.HTTP_404_NOT_FOUND: {"model": OAuthError}
}


# MCP: no — escalation surface
@router.get(
    "/requests/{request_id}", response_model=OAuthRequestRead, responses=_NOT_FOUND
)
async def read_oauth_request(
    request_id: uuid.UUID,
    _user: User = Depends(current_active_user),  # JWT ONLY — anti-escalation
    session: AsyncSession = Depends(get_session),
) -> OAuthRequestRead:
    """What an AI app is asking for, for the consent screen to render.

    Deliberately NOT bound to the user who started the flow: whoever is signed in
    decides for their OWN account. Unknown, expired and already-decided requests
    share one 404 ``OAUTH_REQUEST_NOT_FOUND``.
    """
    found = await read_request(session, request_id)
    if found is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="OAUTH_REQUEST_NOT_FOUND"
        )
    return OAuthRequestRead(
        client_name=found.client_name,
        redirect_host=found.redirect_host,
        loopback=found.loopback,
        expires_at=found.expires_at,
    )


# MCP: no — escalation surface
@router.post(
    "/requests/{request_id}/decision",
    response_model=OAuthDecisionResult,
    responses=_NOT_FOUND,
)
async def decide_oauth_request(
    request: Request,
    request_id: uuid.UUID,
    payload: OAuthDecision,
    user: User = Depends(current_active_user),  # JWT ONLY — anti-escalation
    session: AsyncSession = Depends(get_session),
) -> OAuthDecisionResult:
    """Allow or deny, once. ``redirect_to`` is built from the STORED request row.

    The request is spent either way (single-use under a race), so a double click
    cannot mint two authorization codes and a denial cannot be re-decided.
    """
    settings: Settings = request.app.state.settings
    redirect_to = await decide(
        session,
        request_id,
        user.id,
        allow=payload.decision == "allow",
        scope=payload.scope,
        settings=settings,
    )
    if redirect_to is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="OAUTH_REQUEST_NOT_FOUND"
        )
    return OAuthDecisionResult(redirect_to=redirect_to)


# MCP: no — escalation surface
@router.get("/apps", response_model=OAuthAppList)
async def list_oauth_apps(
    user: User = Depends(current_active_user),  # JWT ONLY — anti-escalation
    session: AsyncSession = Depends(get_session),
) -> OAuthAppList:
    """Every AI app the user connected, revoked ones included (the ``/tokens`` rule).

    Grants ONLY: ``oauth_client_id IS NOT NULL`` is what keeps personal access
    tokens out of this list, exactly as ``/tokens`` keeps grants out of its own.
    """
    rows = (
        await session.execute(
            select(PersonalAccessToken, OAuthClient.client_name)
            .join(OAuthClient, OAuthClient.id == PersonalAccessToken.oauth_client_id)
            .where(
                PersonalAccessToken.user_id == user.id,
                PersonalAccessToken.oauth_client_id.is_not(None),
            )
            .order_by(PersonalAccessToken.created_at.desc(), PersonalAccessToken.id)
        )
    ).all()
    return OAuthAppList(
        items=[
            OAuthAppRead(
                id=grant.id,
                client_name=client_name,
                scope=PatScope(grant.scope),
                created_at=grant.created_at,
                last_used_at=grant.last_used_at,
                revoked_at=grant.revoked_at,
            )
            for grant, client_name in rows
        ]
    )


# MCP: no — escalation surface
@router.delete(
    "/apps/{grant_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    responses=_NOT_FOUND,
)
async def revoke_oauth_app(
    grant_id: uuid.UUID,
    user: User = Depends(current_active_user),  # JWT ONLY — anti-escalation
    session: AsyncSession = Depends(get_session),
) -> None:
    """Disconnect an app. IMMEDIATE: every acceptance path joins ``revoked_at IS NULL``.

    One soft-revoke UPDATE whose WHERE clause is also the authorisation check, so
    foreign, missing, already-revoked and "this is a plain PAT" all come back as
    zero rows — one byte-identical 404 ``OAUTH_APP_NOT_FOUND``.
    """
    revoked = (
        await session.execute(
            update(PersonalAccessToken)
            .where(
                PersonalAccessToken.id == grant_id,
                PersonalAccessToken.user_id == user.id,
                PersonalAccessToken.oauth_client_id.is_not(None),
                PersonalAccessToken.revoked_at.is_(None),
            )
            .values(revoked_at=func.now())
            .returning(PersonalAccessToken.id)
        )
    ).scalar_one_or_none()
    if revoked is None:
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="OAUTH_APP_NOT_FOUND"
        )
    await session.commit()
