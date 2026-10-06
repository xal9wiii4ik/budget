"""Web push device binding and the test push (web-push architecture §6).

**JWT-ONLY, all four routes.** Every handler depends on ``current_active_user``
imported straight from ``auth.py`` (the ``routers/tokens.py`` precedent) and none
carries an MCP marker, so a personal access token is refused twice over: a
``bgt_pat_`` bearer fails the JWT decode, and no ``/push`` pair is in the derived
allowlist. A token has no browser, and a device binding without one means nothing.

**auth → gate → session**, in that signature order (the advisor precedent): an
unauthenticated call answers 401 even on a keyless server, and the
``PUSH_NOT_CONFIGURED`` 503 resolves before slowapi's wrapper, so an unkeyed
server spends no ``/push/test`` quota.

* ``GET /config`` — the honest flag + public key; NOT gated (it is how the web
  learns the server is unconfigured).
* ``POST /subscriptions`` — UPSERT on the globally-unique ``endpoint``: a re-POST
  is idempotent (same ``id`` back) and a device that changed hands is rebound to
  the caller in the same statement. Gated, and the endpoint must pass
  ``domain/push_endpoint.endpoint_allowed`` (the server POSTs to it later).
* ``POST /unsubscribe`` — 204 ALWAYS: deletes only the caller's own row, so a
  foreign or unknown endpoint is byte-identical to a deleted one (no-oracle).
  POST with a body because openapi-fetch and DELETE bodies do not mix. Not gated:
  removing a row needs no keys.
* ``POST /test`` — the fixed test text to every own device; dead devices (404/410)
  are deleted. The read transaction is committed BEFORE the sends, so no pooled
  connection is held across outbound HTTP.
"""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.auth import current_active_user
from budget_api.config import Settings
from budget_api.db import get_session
from budget_api.domain.push_digest import test_digest
from budget_api.domain.push_endpoint import endpoint_allowed
from budget_api.models import Profile, PushSubscription, User
from budget_api.push_gate import require_push_configured
from budget_api.rate_limit import (
    limiter,
    push_test_limit_value,
    rate_limit_exempt,
    stash_rl_user,
    user_rl_key,
)
from budget_api.schemas.push import (
    PushConfigRead,
    PushError,
    PushSubscriptionCreate,
    PushSubscriptionRead,
    PushTestResult,
    PushUnsubscribe,
)
from budget_api.services.push_jobs import digest_lang, read_devices
from budget_api.services.push_sender import PushSender, SendOutcome

router = APIRouter()

_UNAVAILABLE: dict[int | str, dict[str, object]] = {
    status.HTTP_503_SERVICE_UNAVAILABLE: {"model": PushError}
}
_RATE_LIMITED: dict[int | str, dict[str, object]] = {
    status.HTTP_429_TOO_MANY_REQUESTS: {"model": PushError}
}
# The honest anyOf union (routers/recurring.py precedent): the business code
# PUSH_ENDPOINT_INVALID (PushError) AND FastAPI's auto Pydantic array both occur.
# The PushError component itself is registered by the 503 ``model`` entry on the
# same route — a raw $ref alone would dangle (routers/profile.py note).
_UNPROCESSABLE: dict[int | str, dict[str, object]] = {
    status.HTTP_422_UNPROCESSABLE_CONTENT: {
        "description": "Business rule rejection (string code) or validation error",
        "content": {
            "application/json": {
                "schema": {
                    "anyOf": [
                        {"$ref": "#/components/schemas/PushError"},
                        {"$ref": "#/components/schemas/HTTPValidationError"},
                    ]
                }
            }
        },
    }
}

# slowapi's Limiter.limit is typed to return a bare Callable (Unknown); the Any
# alias contains the partial type here (the advisor/receipts routers do the same).
_limiter_any: Any = limiter


def _sender(request: Request) -> PushSender:
    sender: PushSender = request.app.state.push_sender
    return sender


# MCP: no — binds a browser device; meaningless without a browser
@router.get("/config", response_model=PushConfigRead)
async def read_push_config(
    request: Request,
    _user: User = Depends(current_active_user),  # JWT ONLY
) -> PushConfigRead:
    """Whether this server can send pushes, and the VAPID public key to subscribe with.

    ``enabled`` is false (and ``public_key`` null) until the server's VAPID keys
    are configured; the subscribe and test routes answer 503
    ``PUSH_NOT_CONFIGURED`` meanwhile.
    """
    sender = _sender(request)
    return PushConfigRead(enabled=sender.enabled, public_key=sender.public_key)


# MCP: no — binds a browser device; meaningless without a browser
@router.post(
    "/subscriptions",
    response_model=PushSubscriptionRead,
    status_code=status.HTTP_201_CREATED,
    responses={**_UNPROCESSABLE, **_UNAVAILABLE},
)
async def subscribe(
    request: Request,
    payload: PushSubscriptionCreate,
    # ORDER IS LOAD-BEARING (module docstring): auth, then the gate, then the DB.
    user: User = Depends(current_active_user),  # JWT ONLY
    _gate: None = Depends(require_push_configured),
    session: AsyncSession = Depends(get_session),
) -> PushSubscriptionRead:
    """Register this browser for push, or refresh its keys and language.

    Idempotent per ``endpoint``: re-posting the same endpoint updates the keys,
    ``lang`` and ``user_agent`` and returns the SAME ``id``. An endpoint that was
    registered by another account moves to the caller (the device changed hands).
    The endpoint must be an ``https`` URL whose host is a name — not an IP literal
    and not ``localhost`` — else 422 ``PUSH_ENDPOINT_INVALID``.
    """
    settings: Settings = request.app.state.settings
    if not endpoint_allowed(
        payload.endpoint, allow_insecure=settings.push_allow_insecure_endpoints
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="PUSH_ENDPOINT_INVALID",
        )
    stmt = pg_insert(PushSubscription).values(
        user_id=user.id,
        endpoint=payload.endpoint,
        p256dh=payload.keys.p256dh,
        auth=payload.keys.auth,
        lang=payload.lang,
        user_agent=payload.user_agent,
    )
    # Upsert and rebind are ONE statement: the conflict arm rewrites user_id too.
    # ``id`` and ``created_at`` are not in the SET, so a conflict keeps the
    # ORIGINAL row identity — what makes a re-POST idempotent.
    stmt = stmt.on_conflict_do_update(
        index_elements=[PushSubscription.endpoint],
        set_={
            "user_id": stmt.excluded.user_id,
            "p256dh": stmt.excluded.p256dh,
            "auth": stmt.excluded.auth,
            "lang": stmt.excluded.lang,
            "user_agent": stmt.excluded.user_agent,
            "updated_at": func.now(),
        },
    ).returning(
        PushSubscription.id, PushSubscription.endpoint, PushSubscription.created_at
    )
    row = (await session.execute(stmt)).one()
    await session.commit()
    return PushSubscriptionRead(
        id=row.id, endpoint=row.endpoint, created_at=row.created_at
    )


# MCP: no — binds a browser device; meaningless without a browser
@router.post(
    "/unsubscribe", status_code=status.HTTP_204_NO_CONTENT, response_model=None
)
async def unsubscribe(
    payload: PushUnsubscribe,
    user: User = Depends(current_active_user),  # JWT ONLY
    session: AsyncSession = Depends(get_session),
) -> None:
    """Forget this browser. Always 204 — an unknown endpoint is not an error.

    Only the caller's own registration is removed; an endpoint that is not theirs
    is left untouched and answers exactly the same.
    """
    # No rowcount branch, on purpose: "deleted", "never existed" and "someone
    # else's" must be indistinguishable from outside (no-oracle).
    await session.execute(
        delete(PushSubscription).where(
            PushSubscription.endpoint == payload.endpoint,
            PushSubscription.user_id == user.id,
        )
    )
    await session.commit()


# MCP: no — a side effect on the user's devices that an agent cannot observe
@router.post(
    "/test",
    response_model=PushTestResult,
    responses={**_RATE_LIMITED, **_UNAVAILABLE},
)
@_limiter_any.limit(
    push_test_limit_value,
    key_func=user_rl_key("push_test"),
    exempt_when=rate_limit_exempt,
)
async def send_test_push(
    request: Request,
    # ORDER IS LOAD-BEARING (module docstring): auth, then the gate, then the DB.
    user: User = Depends(stash_rl_user),  # JWT ONLY (stash_rl_user wraps it)
    _gate: None = Depends(require_push_configured),
    session: AsyncSession = Depends(get_session),
) -> PushTestResult:
    """Send a test notification to every device registered by this account.

    ``sent`` counts the devices the push service accepted; ``removed`` counts the
    devices it reported gone, whose registrations are deleted. No devices →
    ``{sent: 0, removed: 0}``.
    """
    sender = _sender(request)
    devices = await read_devices(session, user.id)
    profile_language = await session.scalar(
        select(Profile.language).where(Profile.user_id == user.id)
    )
    # End the read transaction BEFORE any outbound HTTP: the connection goes back
    # to the pool instead of idling in a transaction while push services answer.
    await session.commit()

    sent = 0
    gone: list[str] = []
    for device in devices:
        payload = test_digest(digest_lang(profile_language, device.lang)).to_payload()
        outcome = await sender.send(device, payload)
        if outcome is SendOutcome.delivered:
            sent += 1
        elif outcome is SendOutcome.gone:
            gone.append(device.endpoint)

    if gone:
        await session.execute(
            delete(PushSubscription).where(
                PushSubscription.user_id == user.id,
                PushSubscription.endpoint.in_(gone),
            )
        )
        await session.commit()
    return PushTestResult(sent=sent, removed=len(gone))
