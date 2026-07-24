"""Auth routes.

Mounts fastapi-users' stock register + reset routers and adds three thin custom
routes — login / refresh / logout — that drive the library's strategy primitives
directly (architecture §1, Decision A). All three unauthenticated credential
routes (login, register, forgot-password) are rate limited: login via a module
decorator, the two stock routes via post-decoration of their shared route objects
(the only mechanism for routes we don't own — CI-gated by the 429 pytests).
"""

from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response, status
from fastapi.routing import APIRoute
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.requests import Request

from budget_api.auth import (
    UserManager,
    fastapi_users,
    get_jwt_strategy,
    get_refresh_strategy,
    get_user_manager,
)
from budget_api.db import get_session
from budget_api.rate_limit import (
    forgot_password_limit_value,
    limiter,
    login_limit_value,
    prime_rate_limit,
    rate_limit_exempt,
    register_limit_value,
)
from budget_api.schemas.auth import (
    LogoutRequest,
    RateLimitedError,
    RefreshRequest,
    TokenPair,
)
from budget_api.schemas.user import UserCreate, UserRead

_RATE_LIMITED_RESPONSE: dict[int | str, dict[str, Any]] = {
    status.HTTP_429_TOO_MANY_REQUESTS: {
        "model": RateLimitedError,
        "description": "Rate limited",
    }
}

# prime_rate_limit is a router-level dependency (finding 4): the priming of the
# per-request settings contextvar travels with the router that post-decorates these
# routes, so the router can never be mounted unprimed (which would 500 the limiter).
router = APIRouter(
    prefix="/auth", tags=["auth"], dependencies=[Depends(prime_rate_limit)]
)

# Stock routers: response_model + safe register drop privilege fields (plan §13.5).
router.include_router(
    fastapi_users.get_register_router(UserRead, UserCreate)  # type: ignore[arg-type]
)
router.include_router(fastapi_users.get_reset_password_router())


@router.post("/login", response_model=TokenPair, responses={**_RATE_LIMITED_RESPONSE})
async def login(
    request: Request,
    credentials: OAuth2PasswordRequestForm = Depends(),
    user_manager: UserManager = Depends(get_user_manager),
    session: AsyncSession = Depends(get_session),
) -> TokenPair:
    user = await user_manager.authenticate(credentials)
    # authenticate() returns None on bad creds and does NOT check is_active
    # (plan §13.4/§13.7) — re-check explicitly, no account-existence oracle.
    if user is None or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="LOGIN_BAD_CREDENTIALS"
        )
    settings = request.app.state.settings
    access = await get_jwt_strategy(request).write_token(user)
    refresh = await get_refresh_strategy(session, settings).write_token(user)
    return TokenPair(access_token=access, refresh_token=refresh)


@router.post("/refresh", response_model=TokenPair)
async def refresh(
    request: Request,
    body: RefreshRequest,
    user_manager: UserManager = Depends(get_user_manager),
    session: AsyncSession = Depends(get_session),
) -> TokenPair:
    settings = request.app.state.settings
    strategy = get_refresh_strategy(session, settings)
    user = await strategy.read_token(body.refresh_token, user_manager)
    # read_token enforces existence + max age but not is_active (plan §13.4).
    if user is None or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="REFRESH_TOKEN_INVALID"
        )
    # Rotation: consume the presented token, issue a fresh pair.
    await strategy.destroy_token(body.refresh_token, user)
    access = await get_jwt_strategy(request).write_token(user)
    new_refresh = await strategy.write_token(user)
    return TokenPair(access_token=access, refresh_token=new_refresh)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    request: Request,
    body: LogoutRequest,
    session: AsyncSession = Depends(get_session),
) -> Response:
    # Revoke-by-possession; always 204, even for an unknown token (no oracle).
    # destroy_token is a no-op when the token is absent (adapter returns None).
    settings = request.app.state.settings
    strategy = get_refresh_strategy(session, settings)
    access_token = await strategy.database.get_by_token(body.refresh_token)
    if access_token is not None:
        await strategy.database.delete(access_token)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _find_route(path: str) -> APIRoute:
    """Locate a route by path, whether defined directly on this router (our own
    ``/auth/login``, full path) or mounted from an included stock router (its
    unprefixed path, e.g. ``/register``, under ``original_router``)."""
    for entry in router.routes:
        if isinstance(entry, APIRoute) and entry.path == path:
            return entry
        original = getattr(entry, "original_router", None)
        if original is not None:
            for route in original.routes:
                if isinstance(route, APIRoute) and route.path == path:
                    return route
    raise RuntimeError(f"cannot rate-limit unknown route: {path}")


def _apply_limit(path: str, limit_provider: Callable[[], str]) -> None:
    """Post-decorate a route's shared endpoint with the limiter.

    Uniform mechanism for our own login route and the stock register/forgot-password
    routes we don't define — it touches Starlette route internals
    (``endpoint``/``dependant.call``) but avoids an untyped def-time decorator, and
    every target endpoint already declares a ``request: Request`` parameter
    (slowapi's requirement). CI-gated by the 429 pytests (AM-D). Also declares the
    429 response so the schema matches the body.
    """
    route = _find_route(path)
    # slowapi's Limiter.limit is typed to return a bare Callable (Unknown return),
    # which trips pyright-strict reportUnknownMemberType; route the one call through
    # an Any-typed alias so the partial type stays contained to this helper.
    limiter_any: Any = limiter
    decorated: Callable[..., Any] = limiter_any.limit(
        limit_provider, exempt_when=rate_limit_exempt
    )(route.endpoint)
    route.endpoint = decorated
    route.dependant.call = decorated
    route.responses = {**route.responses, **_RATE_LIMITED_RESPONSE}


_apply_limit("/auth/login", login_limit_value)
_apply_limit("/register", register_limit_value)
_apply_limit("/forgot-password", forgot_password_limit_value)
