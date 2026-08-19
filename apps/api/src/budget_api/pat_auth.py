"""Personal-access-token authentication — JWT's neighbour, never its replacement.

Sibling of ``auth.py`` (framework glue, not a ``services/`` integration). Exposes
ONE dependency, :func:`current_user_jwt_or_pat`, which the data routers use in
place of ``current_active_user``:

* ``Authorization: Bearer bgt_pat_…`` → the PAT branch below;
* anything else → the ordinary fastapi-users JWT path (a JWT always starts with
  ``eyJ``), with the SAME bare ``401 Unauthorized`` fastapi-users itself raises.

The PAT branch returns the token owner's ``User``, so every downstream invariant —
``user_id`` scoping, no-oracle 404s, minor units, the rate snapshot — keeps
working with no per-router code (architecture §7).

Enforcement order inside the branch is load-bearing (plan §Approach):

1. hash lookup — missing, revoked and inactive-owner collapse into ONE
   ``401 TOKEN_INVALID`` (no oracle: "never existed" is indistinguishable from
   "revoked");
2. **allowlist, fail-closed and FIRST of the gates** — a pair that is not in
   :data:`PAT_ALLOWLIST` is ``403 TOKEN_ENDPOINT_FORBIDDEN`` before scope is ever
   consulted, so an unknown path cannot leak "…but your scope was fine";
3. write method on a ``read`` token → ``403 TOKEN_SCOPE_READONLY``;
4. per-token rate limit → ``429 RATE_LIMITED``;
5. debounced ``last_used_at`` (committed BEFORE the handler runs: a handler that
   later fails does not un-use the token) and the ``request.state.pat`` stash the
   audit middleware reads.

JWT requests never touch gates 2-5. The MCP package asks ``GET /tokens/self`` for
its own scope so it can hide write tools from a read token — that is UX; THIS
module is the only enforcement.
"""

import hashlib
import uuid
from dataclasses import dataclass
from typing import Any

from fastapi import Depends, HTTPException, Request, status
from limits import parse_many
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.types import Scope

from budget_api.auth import fastapi_users
from budget_api.config import Settings
from budget_api.db import get_session
from budget_api.enums import PatScope
from budget_api.models import PersonalAccessToken, User
from budget_api.rate_limit import limiter

#: Everything after it is ``secrets.token_urlsafe(32)``. The prefix is what makes
#: the branch decision possible without trying (and failing) a JWT decode first,
#: and what makes a leaked token greppable in logs and repos.
PAT_PREFIX = "bgt_pat_"

_BEARER = "bearer"

#: Methods that change state. Everything here needs ``full``; any other method is
#: scope-agnostic, which in practice means the GET pairs of the allowlist (HEAD has
#: no pair there, so it is 403 at the gate before scope is consulted). Derived from
#: the METHOD, not from a third column in the allowlist — there is nothing for a
#: table to drift from.
_WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})

#: The curated (method, route template) surface a PAT may reach = architecture §4.
#: FAIL-CLOSED: anything absent here is 403, so a new route is unreachable by a
#: token until someone deliberately adds it. Route templates are matched against
#: ``request.scope["route"].path_format``, which carries the router prefix and is
#: byte-identical to the path key in ``openapi.json`` (pinned by
#: tests/test_pat_auth.py::TestAllowlistContract).
#:
#: Deliberately ABSENT: ``GET /transactions/export`` (streaming CSV), every
#: ``/receipts``/``/advisor``/``/users``/``/auth`` route, and every DELETE except
#: the single transaction one (user decision, 2026-08-19).
PAT_ALLOWLIST: frozenset[tuple[str, str]] = frozenset(
    {
        ("GET", "/transactions"),
        ("GET", "/transactions/summary"),
        ("POST", "/transactions"),
        ("PATCH", "/transactions/{transaction_id}"),
        # The ONE destructive tool (architecture §4): requires ``full`` like every
        # other write, and the MCP package does not publish it to a read token.
        ("DELETE", "/transactions/{transaction_id}"),
        ("GET", "/categories"),
        ("POST", "/categories"),
        # Archiving a category IS deleting it in this product, and it happens here.
        ("PATCH", "/categories/{category_id}"),
        ("GET", "/goals"),
        ("GET", "/goals/{goal_id}"),
        ("GET", "/goals/{goal_id}/progress"),
        ("GET", "/goals/{goal_id}/contributions"),
        ("POST", "/goals"),
        ("PATCH", "/goals/{goal_id}"),
        ("POST", "/goals/{goal_id}/contributions"),
        ("GET", "/limits"),
        ("PUT", "/limits/{category_id}"),
        ("GET", "/recurring"),
        ("POST", "/recurring"),
        ("PATCH", "/recurring/{template_id}"),
        ("GET", "/stats/summary"),
        ("GET", "/stats/monthly"),
        ("GET", "/stats/top-merchants"),
        ("GET", "/fx/convert"),
        # The ONLY /tokens route a token may call: self-introspection, {id, scope}.
        # A token can neither mint nor revoke tokens (anti-escalation, §4).
        ("GET", "/tokens/self"),
    }
)


@dataclass(frozen=True)
class PatContext:
    """What the request carries about the token that authenticated it.

    Stashed on ``request.state.pat``; read by ``GET /tokens/self`` and by the audit
    middleware. Deliberately NOT the ORM row: the middleware runs after the request
    session is closed, so a detached instance would be a lazy-load trap.
    """

    id: uuid.UUID
    user_id: uuid.UUID
    scope: PatScope


def hash_token(token: str) -> str:
    """SHA-256 hex of the FULL token string — the only form ever stored (§1)."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def route_template(scope: Scope) -> str | None:
    """The FULL route template of the matched route, e.g. ``/goals/{goal_id}``.

    Not simply ``scope["route"].path_format``: since fastapi 0.139 ``include_router``
    mounts the sub-router itself instead of copying its routes, so ``scope["route"]``
    is the ORIGINAL route object whose ``path_format`` is router-RELATIVE (``""`` for
    ``POST /transactions``). The prefixed template lives on the effective route
    context fastapi puts in the scope while handling the request; the original route
    is the fallback for a route declared straight on the app.

    Returns None when neither is available — and every caller here treats None as
    "not allowed" / "unknown path", so a future framework change fails CLOSED and is
    caught loudly by the suite rather than opening a hole.
    """
    fastapi_scope: dict[str, Any] = scope.get("fastapi") or {}
    candidates: tuple[Any, Any] = (
        fastapi_scope.get("effective_route_context"),
        scope.get("route"),
    )
    for candidate in candidates:
        path_format: Any = getattr(candidate, "path_format", None)
        if isinstance(path_format, str) and path_format:
            return path_format
    return None


def _pat_from_request(request: Request) -> str | None:
    """The raw PAT from ``Authorization``, or None when this is not a PAT request."""
    header = request.headers.get("Authorization")
    if header is None:
        return None
    parts = header.split(maxsplit=1)
    if len(parts) != 2 or parts[0].lower() != _BEARER:
        return None
    token = parts[1].strip()
    return token if token.startswith(PAT_PREFIX) else None


# optional=True so a PAT string (which is not a decodable JWT) yields None instead
# of a 401 raised before the PAT branch ever runs. The security scheme handed to
# OpenAPI is the SAME shared OAuth2PasswordBearer object current_active_user uses,
# so the contract's `security` block is unchanged by the migration.
_jwt_user_optional = fastapi_users.current_user(active=True, optional=True)


def _enforce_rate_limit(request: Request, pat_id: uuid.UUID, is_write: bool) -> None:
    """Per-token moving window, hit directly on the shared limiter's storage.

    Not ``@limiter.limit`` decorators on ~25 routes: a decorator mutates the shared
    route object, so it would also throttle the SAME routes' JWT traffic and spread
    one policy across two dozen call sites. ``rate_limit_scope`` keeps counters
    isolated per app instance (AM-C), exactly as the decorated routes do.

    ``hit`` is synchronous — correct for the in-memory storage this app uses; a
    move to Redis storage (HTTP phase 2) would turn it into a blocking call inside
    an async handler and MUST be revisited then.
    """
    settings: Settings = request.app.state.settings
    if not settings.rate_limit_enabled:
        return
    scope_prefix: str = getattr(request.app.state, "rate_limit_scope", "default")
    namespace = "pat-write" if is_write else "pat-read"
    value = settings.pat_write_rate_limit if is_write else settings.pat_read_rate_limit
    key = f"{scope_prefix}:{namespace}:{pat_id}"
    for item in parse_many(value):
        if not limiter.limiter.hit(item, key):
            # The house 429 envelope (AM-I), same bytes the slowapi handler emits.
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="RATE_LIMITED"
            )


async def _touch_last_used(
    session: AsyncSession, pat_id: uuid.UUID, debounce_seconds: int
) -> None:
    """One debounced UPDATE, committed before the handler runs (architecture §2)."""
    await session.execute(
        text(
            "UPDATE personal_access_tokens SET last_used_at = now() "
            "WHERE id = :id AND (last_used_at IS NULL OR last_used_at < "
            "now() - make_interval(secs => cast(:secs as double precision)))"
        ),
        {"id": pat_id, "secs": debounce_seconds},
    )
    await session.commit()


async def current_user_jwt_or_pat(
    request: Request,
    jwt_user: User | None = Depends(_jwt_user_optional),
    session: AsyncSession = Depends(get_session),
) -> User:
    """Authenticate by PAT when the bearer carries the PAT prefix, else by JWT."""
    raw = _pat_from_request(request)
    if raw is None:
        if jwt_user is None:
            # Byte-identical to what fastapi-users' non-optional dependency raises,
            # so migrating a route to this dependency changes no 401 response.
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)
        return jwt_user

    row = (
        await session.execute(
            select(PersonalAccessToken, User)
            .join(User, PersonalAccessToken.user_id == User.id)
            .where(
                PersonalAccessToken.token_hash == hash_token(raw),
                PersonalAccessToken.revoked_at.is_(None),
            )
        )
    ).first()
    # ONE raise for "no such token", "revoked" and "owner deactivated": three
    # different facts, one indistinguishable answer (no-oracle, architecture §2).
    if row is None or not row[1].is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="TOKEN_INVALID"
        )
    pat, user = row[0], row[1]

    # An unresolvable template is treated as "not in the allowlist" — fail closed.
    path_format = route_template(request.scope)
    if path_format is None or (request.method, path_format) not in PAT_ALLOWLIST:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="TOKEN_ENDPOINT_FORBIDDEN"
        )

    is_write = request.method in _WRITE_METHODS
    if is_write and pat.scope != PatScope.full:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="TOKEN_SCOPE_READONLY"
        )

    _enforce_rate_limit(request, pat.id, is_write)

    settings: Settings = request.app.state.settings
    await _touch_last_used(session, pat.id, settings.pat_last_used_debounce_seconds)
    request.state.pat = PatContext(
        id=pat.id, user_id=pat.user_id, scope=PatScope(pat.scope)
    )
    return user
