"""slowapi rate limiting — per-app-safe over a process-global limiter (AM-C).

Design constraint (verified against FastAPI 0.139.2): ``include_router`` references
the SAME router/route objects across every app instance, and ``@limiter.limit``
decoration mutates those shared route objects. Per-app ``Limiter`` instances are
therefore impossible — there is exactly one limiter and one set of decorated routes
in the process. Per-app safety is achieved dynamically per request instead:

1. **Enable/disable per app** — ``_exempt_when`` reads ``rate_limit_enabled`` from
   the current request's settings (carried in a contextvar primed by
   ``prime_rate_limit``). A disabled app is fully exempt; storage is never touched.
2. **Limit value per app** — ``_login_limit``/``_register_limit``/
   ``_forgot_password_limit`` read the same settings, so tests shrink limits per
   app instance.
3. **Storage isolation per app** — ``_key_func`` prefixes the rate key with the
   app's ``rate_limit_scope`` (a uuid set in ``create_app``), so two enabled apps
   never share counters and there is no cross-test bleed.

``headers_enabled=False`` because slowapi's success-path header injection requires
a ``response`` parameter the stock register/reset routes lack; the custom 429
handler returns ``{"detail": "RATE_LIMITED"}`` (AM-I). Retry-After/rate-limit
headers are dropped (AM-I: nice-to-have, not a gate).
"""

from collections.abc import Callable
from contextvars import ContextVar

from fastapi import Depends, Request
from fastapi.responses import JSONResponse
from slowapi import Limiter
from slowapi.util import get_remote_address
from starlette.responses import Response

from budget_api.auth import current_active_user
from budget_api.config import Settings
from budget_api.models import User

# Holds the current request's settings for the limit-value/exempt callables, which
# slowapi does not hand the request. Primed by prime_rate_limit before the check.
_request_settings: ContextVar[Settings] = ContextVar("rate_limit_request_settings")


def _key_func(request: Request) -> str:
    scope: str = getattr(request.app.state, "rate_limit_scope", "default")
    return f"{scope}:{get_remote_address(request)}"


limiter = Limiter(key_func=_key_func, headers_enabled=False)


def rate_limit_exempt() -> bool:
    # Return True to EXEMPT the request from limiting (per-app enable/disable).
    return not _request_settings.get().rate_limit_enabled


def login_limit_value() -> str:
    return _request_settings.get().login_rate_limit


def register_limit_value() -> str:
    return _request_settings.get().register_rate_limit


def forgot_password_limit_value() -> str:
    return _request_settings.get().forgot_password_rate_limit


def receipt_create_limit_value() -> str:
    return _request_settings.get().receipt_create_rate_limit


def receipt_parse_limit_value() -> str:
    return _request_settings.get().receipt_parse_rate_limit


def advisor_ask_limit_value() -> str:
    return _request_settings.get().advisor_ask_rate_limit


def user_rl_key(namespace: str) -> Callable[[Request], str]:
    """Per-user rate key factory → ``"<scope>:<ns>:<user id|remote addr>"`` (D10).

    The AI-spending endpoints key on the authenticated account, not the IP: on
    localhost every account shares one address, and the account is the cost driver
    (each parse/ask is an Anthropic spend). ``request.state.rl_user_id`` is stashed
    by the :func:`stash_rl_user` dependency, which resolves before slowapi's
    wrapper runs. Pre-auth (dependency not yet run) it falls back to the remote
    address — never reached in practice because the limited routes require auth.

    The ``namespace`` segment is defence in depth ALONGSIDE slowapi's own counter
    scoping: slowapi already tracks a separate counter per decorated endpoint, so
    a receipt parse and an advisor ask would not share a budget even on identical
    key strings. The segment makes that separation visible in the stored key (and
    survives a future move to a shared/manual counter). The ``rate_limit_scope``
    prefix keeps counters isolated per app instance (AM-C).
    """

    def key(request: Request) -> str:
        scope: str = getattr(request.app.state, "rate_limit_scope", "default")
        uid: str = getattr(request.state, "rl_user_id", None) or get_remote_address(
            request
        )
        return f"{scope}:{namespace}:{uid}"

    return key


#: The receipt routes' key. Name (and produced key bytes) kept from the 1.5
#: single-purpose function so the receipts import site is unchanged.
receipt_rl_key = user_rl_key("receipt")


async def stash_rl_user(
    request: Request, user: User = Depends(current_active_user)
) -> User:
    """Stash the authenticated user id for the per-user rate keys.

    Runs as an endpoint dependency (resolved before slowapi's wrapper), so
    :func:`user_rl_key`'s closure reads ``request.state.rl_user_id`` on the limited
    routes. ONE stash mechanism for every namespace (D10) — it lives here, next to
    the reader, rather than in whichever router happened to need it first.

    ``rate_limit → auth → models`` is acyclic: ``auth`` imports config/db/models
    and never imports this module.
    """
    request.state.rl_user_id = str(user.id)
    return user


async def prime_rate_limit(request: Request) -> None:
    """Router-level dependency: snapshot this request's settings for the limiter.

    Runs before slowapi's auto-check (dependencies resolve before the endpoint
    wrapper), so the contextvar is populated when the limit callables read it.
    """
    _request_settings.set(request.app.state.settings)


def rate_limit_exceeded_handler(request: Request, exc: Exception) -> Response:
    # One error envelope across the API (AM-I): detail, never slowapi's {"error"}.
    # Registered only for RateLimitExceeded; typed as Exception to satisfy
    # Starlette's ExceptionHandler signature.
    return JSONResponse({"detail": "RATE_LIMITED"}, status_code=429)
