"""Reading a parked authorization request, and deciding it.

The two halves of the consent screen, and the security property of both is the
same: **the browser never says where the authorization response goes.** The
decision route is handed a request id and a yes/no; the redirect is composed from
the STORED row with the SDK's ``construct_redirect_uri``. There is no field in any
request body that could move it.

Consumption is ``UPDATE … SET consumed_at = now() WHERE id = … AND consumed_at IS
NULL AND expires_at > now() RETURNING …`` — one statement, so a double-click (or a
race between two tabs) produces exactly one code and the loser is indistinguishable
from "no such request". ``read_request`` applies the same two predicates, so an
expired or already-decided request is a 404 on the read as well.

The decision is **not** bound to the user who started the flow: whoever is logged
in decides for THEIR OWN account (the grant is created for them). Holding the id
therefore authorises nothing — which is why the id is an ordinary uuid4 PK
(architecture §D6).
"""

import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from urllib.parse import urlsplit

from mcp.server.auth.provider import construct_redirect_uri
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.config import Settings
from budget_api.enums import PatScope
from budget_api.models import (
    OAuthAuthorizationCode,
    OAuthAuthorizationRequest,
    OAuthClient,
)
from budget_api.oauth.clients import is_loopback
from budget_api.oauth.tokens import OAUTH_CODE_PREFIX, hash_token, mint

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ConsentRequest:
    """What the consent page may learn about a pending request.

    Deliberately not the row: no ``state``, no ``code_challenge``, no full
    ``redirect_uri`` — the page shows the HOST (the one part a human can judge)
    and whether it is a loopback address, which is the "this is a program on your
    own machine" signal.
    """

    client_name: str | None
    redirect_host: str
    loopback: bool
    expires_at: datetime


async def read_request(
    session: AsyncSession, request_id: uuid.UUID
) -> ConsentRequest | None:
    """A live, undecided request — or None for unknown, expired and consumed alike."""
    row = (
        await session.execute(
            select(
                OAuthAuthorizationRequest.redirect_uri,
                OAuthAuthorizationRequest.expires_at,
                OAuthClient.client_name,
            )
            .join(OAuthClient, OAuthClient.id == OAuthAuthorizationRequest.client_id)
            .where(
                OAuthAuthorizationRequest.id == request_id,
                OAuthAuthorizationRequest.consumed_at.is_(None),
                OAuthAuthorizationRequest.expires_at > func.now(),
            )
        )
    ).first()
    if row is None:
        return None
    redirect_uri: str = row[0]
    expires_at: datetime = row[1]
    client_name: str | None = row[2]
    return ConsentRequest(
        client_name=client_name,
        redirect_host=urlsplit(redirect_uri).hostname or "",
        loopback=is_loopback(redirect_uri),
        expires_at=expires_at,
    )


async def decide(
    session: AsyncSession,
    request_id: uuid.UUID,
    user_id: uuid.UUID,
    *,
    allow: bool,
    scope: PatScope,
    settings: Settings,
) -> str | None:
    """Consume the request and return where to send the browser, or None → 404.

    On ``allow`` an authorization code is minted for ``user_id`` carrying the mode
    the user picked; on deny the client is told ``access_denied``. Either way the
    request is spent and the URL is built from the stored row.
    """
    consumed = (
        await session.execute(
            update(OAuthAuthorizationRequest)
            .where(
                OAuthAuthorizationRequest.id == request_id,
                OAuthAuthorizationRequest.consumed_at.is_(None),
                OAuthAuthorizationRequest.expires_at > func.now(),
            )
            .values(consumed_at=func.now())
            .returning(
                OAuthAuthorizationRequest.client_id,
                OAuthAuthorizationRequest.redirect_uri,
                OAuthAuthorizationRequest.code_challenge,
                OAuthAuthorizationRequest.state,
                OAuthAuthorizationRequest.resource,
            )
        )
    ).first()
    if consumed is None:
        await session.rollback()
        return None
    client_id: uuid.UUID = consumed[0]
    redirect_uri: str = consumed[1]
    code_challenge: str = consumed[2]
    state: str | None = consumed[3]
    resource: str | None = consumed[4]

    if not allow:
        await session.commit()
        logger.info("oauth consent denied: request=%s", request_id)
        # RFC 6749 §4.1.2.1 — the client learns the user said no, nothing else.
        return construct_redirect_uri(redirect_uri, error="access_denied", state=state)

    code = mint(OAUTH_CODE_PREFIX)
    now = (await session.execute(select(func.now()))).scalar_one()
    session.add(
        OAuthAuthorizationCode(
            code_hash=hash_token(code),
            user_id=user_id,
            client_id=client_id,
            scope=scope.value,
            redirect_uri=redirect_uri,
            code_challenge=code_challenge,
            resource=resource,
            expires_at=now
            + timedelta(seconds=settings.oauth_authorization_code_lifetime_seconds),
        )
    )
    await session.commit()
    logger.info("oauth consent allowed: request=%s scope=%s", request_id, scope.value)
    return construct_redirect_uri(redirect_uri, code=code, state=state)
