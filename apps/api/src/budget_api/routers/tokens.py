"""Personal access tokens — issue / list / revoke, plus one self-introspection route.

**Anti-escalation is the point of this module** (architecture §2/§4): the three
management routes depend on ``current_active_user`` — the JWT-only dependency
imported straight from ``auth.py`` — so a personal access token can never mint or
revoke a token, no matter what the allowlist says. No handler here carries an MCP
marker except the ONE read below, so no other ``/tokens`` pair is in the derived
allowlist either — a PAT reaching POST/GET-list/DELETE is stopped twice over.

``GET /self`` is that exception, and it is declared FIRST (the ``/transactions``
``/summary``-before-``/{id}`` landmine): it answers ``{id, scope}`` about the
CALLING token and nothing else. It is marked ``@pat_reachable`` rather than
``@mcp_tool``: reachable by a token, but no tool — the MCP server calls it at
startup, on its own, so it does not publish write tools to a read token — a
courtesy the token could have discovered with one probe call, hence no new
information and no escalation. A browser
session has no token to introspect, so it gets the same ``404 TOKEN_NOT_FOUND``
a stranger would.

The plaintext is generated here, hashed here, and returned exactly once. Nothing
in this module logs it, and no schema outside ``TokenCreated`` can carry it.
"""

import secrets
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.auth import current_active_user
from budget_api.db import get_session
from budget_api.enums import PatScope
from budget_api.mcp.decorator import pat_reachable
from budget_api.models import PersonalAccessToken, User
from budget_api.pat_auth import (
    PAT_PREFIX,
    PatContext,
    current_user_jwt_or_pat,
    hash_token,
)
from budget_api.schemas.token import (
    TokenCreate,
    TokenCreated,
    TokenError,
    TokenList,
    TokenRead,
    TokenSelf,
)

router = APIRouter()

# Mirrors routers/goals.py: stable UPPER_SNAKE codes carried in {"detail": ...}.
_NOT_FOUND: dict[int | str, dict[str, object]] = {
    status.HTTP_404_NOT_FOUND: {"model": TokenError}
}

#: 32 bytes from ``secrets`` → 43 url-safe characters, ~256 bits. Brute force is
#: irrelevant at that width, which is exactly why SHA-256 (not a KDF) is the right
#: storage form (architecture §1).
_TOKEN_BYTES = 32


def _serialize(row: PersonalAccessToken) -> TokenRead:
    return TokenRead(
        id=row.id,
        name=row.name,
        scope=PatScope(row.scope),
        created_at=row.created_at,
        last_used_at=row.last_used_at,
        revoked_at=row.revoked_at,
    )


@router.get("/self", response_model=TokenSelf, responses=_NOT_FOUND)
@pat_reachable(
    reason="startup introspection: the server asks its own scope; not a tool"
)
async def read_token_self(
    request: Request,
    # The ONE PAT-reachable route here. A JWT session authenticates fine and then
    # falls through to the 404 below — the route is meaningless without a token.
    user: User = Depends(current_user_jwt_or_pat),
) -> TokenSelf:
    """The calling token's own ``{id, scope}`` — no name, no timestamps, no list."""
    pat: PatContext | None = getattr(request.state, "pat", None)
    if pat is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="TOKEN_NOT_FOUND"
        )
    return TokenSelf(id=pat.id, scope=pat.scope)


@router.post("", response_model=TokenCreated, status_code=status.HTTP_201_CREATED)
async def create_token(
    payload: TokenCreate,
    user: User = Depends(current_active_user),  # JWT ONLY — anti-escalation
    session: AsyncSession = Depends(get_session),
) -> TokenCreated:
    """Issue a token. The plaintext in the response is the ONLY copy that exists."""
    plaintext = PAT_PREFIX + secrets.token_urlsafe(_TOKEN_BYTES)
    row = PersonalAccessToken(
        user_id=user.id,
        name=payload.name,
        token_hash=hash_token(plaintext),
        scope=payload.scope.value,
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return TokenCreated(
        id=row.id,
        name=row.name,
        scope=PatScope(row.scope),
        created_at=row.created_at,
        token=plaintext,
    )


@router.get("", response_model=TokenList)
async def list_tokens(
    user: User = Depends(current_active_user),  # JWT ONLY — anti-escalation
    session: AsyncSession = Depends(get_session),
) -> TokenList:
    """Every token the user owns, revoked ones included (the revocation is a fact).

    PLAIN tokens only: ``oauth_client_id IS NULL`` keeps OAuth grants out, because
    a grant is not a string the user holds and it is managed in its own section
    (``GET /oauth/apps``). The mirror predicate lives there, so the two lists can
    never show each other's rows.
    """
    rows = (
        await session.scalars(
            select(PersonalAccessToken)
            .where(
                PersonalAccessToken.user_id == user.id,
                PersonalAccessToken.oauth_client_id.is_(None),
            )
            .order_by(PersonalAccessToken.created_at.desc(), PersonalAccessToken.id)
        )
    ).all()
    return TokenList(items=[_serialize(row) for row in rows])


@router.delete(
    "/{token_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    responses=_NOT_FOUND,
)
async def revoke_token(
    token_id: uuid.UUID,
    user: User = Depends(current_active_user),  # JWT ONLY — anti-escalation
    session: AsyncSession = Depends(get_session),
) -> None:
    """Soft revoke. Foreign, missing and already-revoked share ONE 404 (no-oracle).

    A GRANT id lands in that same 404: ``oauth_client_id IS NULL`` is part of the
    WHERE clause, so this route cannot disconnect an AI app (and ``DELETE
    /oauth/apps/{id}`` cannot revoke a PAT) — neither is an existence oracle for
    the other kind.
    """
    row = await session.scalar(
        select(PersonalAccessToken).where(
            PersonalAccessToken.id == token_id,
            PersonalAccessToken.user_id == user.id,
            PersonalAccessToken.oauth_client_id.is_(None),
            PersonalAccessToken.revoked_at.is_(None),
        )
    )
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="TOKEN_NOT_FOUND"
        )
    row.revoked_at = datetime.now(UTC)
    await session.commit()
