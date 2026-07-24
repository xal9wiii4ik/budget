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

from contextvars import ContextVar

from fastapi import Request
from fastapi.responses import JSONResponse
from slowapi import Limiter
from slowapi.util import get_remote_address
from starlette.responses import Response

from budget_api.config import Settings

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
