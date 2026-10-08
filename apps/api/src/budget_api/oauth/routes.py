"""The authorization server's HTTP surface — plain Starlette routes.

These six routes are deliberately NOT FastAPI routes and NOT in
``apps/api/openapi.json``: their shapes are the RFCs' (8414, 9728, 6749, 7591),
their only consumer is an OAuth client, and ``api-client``/web/mobile never call
them. What IS in the contract is the four JWT-only consent/management routes of
``routers/oauth.py``.

They are also not built with the SDK's ``create_auth_routes``: that helper hard-codes
root paths (``/authorize``, ``/token``, ``/register``) and builds the metadata from
them, which cannot express this deployment's topology — the public prefix ``/api/``
exists only in front of this app, so the paths served here and the paths published
in the metadata are deliberately different strings (``oauth/urls.py``).

``/mcp`` is here too, and it is the one route served as a RAW ASGI object: the
SDK's bearer middleware emits the ``401`` + ``WWW-Authenticate: Bearer …
resource_metadata="…"`` that a remote client needs, and the transport under it
reads the ``http.request`` messages itself. It is a ``Route`` and never a
``Mount``: a ``Mount("/mcp")`` compiles to ``^/mcp/…`` and the router's
``redirect_slashes`` would answer ``/mcp`` with a 307 to ``/mcp/`` — a redirect
every HTTP client follows WITHOUT the ``Authorization`` header, which is exactly
the "authorization is dropped" failure in the troubleshooting doc.

Two SDK handlers are wrapped, and each wrapper earns its place:

* ``/oauth/register`` — the SDK's own ``RequestBodyLimitMiddleware`` caps the body
  at 16 KiB (reused, not re-implemented; its 4 MiB default is for ``/mcp``), and a
  per-IP limiter runs BEFORE the handler so a REFUSED registration still spends
  the bucket (ruling R8). The body cap sits outside the limiter on purpose: an
  oversized body is refused from ``Content-Length`` alone, without reading it.
* ``/oauth/token`` — a non-form body is answered ``400 invalid_request`` rather
  than being allowed to fall through to "missing client_id" 401. RFC 6749 §4.1.3
  requires form encoding, Anthropic's own troubleshooting notes name a 415 here as
  the classic break, and a JSON body is the mistake a client actually makes.

``/oauth/authorize`` and ``/oauth/token`` also carry the 60/minute per-IP limiter:
they are PRE-grant, so there is no token to key a limit on (architecture §D9).

Registration order matters and is handled by the caller (``app.py``): these routes
go on the app BEFORE ``app.state.pat_allowlist`` is derived, so the exposure walk
meets them and its ``TypeError`` tripwire fires at startup — in production, not
only in a test (ruling R7).
"""

from collections.abc import Awaitable, Callable

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from limits import parse_many
from mcp.server.auth.handlers.authorize import AuthorizationHandler
from mcp.server.auth.handlers.metadata import (
    MetadataHandler,
    ProtectedResourceMetadataHandler,
)
from mcp.server.auth.handlers.register import RegistrationHandler
from mcp.server.auth.handlers.token import TokenHandler
from mcp.server.auth.middleware.bearer_auth import (
    BearerAuthBackend,
    RequireAuthMiddleware,
)
from mcp.server.auth.provider import AccessToken, TokenVerifier
from mcp.server.auth.settings import ClientRegistrationOptions
from mcp.server.streamable_http_manager import (
    StreamableHTTPASGIApp,
    StreamableHTTPSessionManager,
)
from mcp.server.transport_security import RequestBodyLimitMiddleware
from mcp.shared.auth import OAuthMetadata, ProtectedResourceMetadata
from pydantic import AnyHttpUrl
from slowapi.util import get_remote_address
from starlette.middleware.authentication import AuthenticationMiddleware
from starlette.requests import Request
from starlette.responses import Response
from starlette.routing import Route, request_response
from starlette.types import ASGIApp

from budget_api.config import Settings
from budget_api.oauth.client_auth import BudgetClientAuthenticator
from budget_api.oauth.clients import ALLOWED_AUTH_METHODS
from budget_api.oauth.provider import BudgetOAuthProvider
from budget_api.oauth.urls import PublicUrls
from budget_api.rate_limit import limiter

#: RFC 7591 §3.1: registration is a JSON POST. 16 KiB is ~8x the largest honest
#: body (ten 2 KB URIs is already refused by the DCR caps) and stops a megabyte of
#: garbage from being parsed by an anonymous caller.
REGISTER_MAX_BODY_BYTES = 16384

#: The content types ``request.form()`` can actually parse. Anything else at the
#: token endpoint is a client bug worth naming (see the module docstring).
_FORM_CONTENT_TYPES = (
    "application/x-www-form-urlencoded",
    "multipart/form-data",
)

_NO_STORE = {"Cache-Control": "no-store", "Pragma": "no-cache"}

#: What the SDK's handlers are, and therefore what the wrappers below take and
#: return: starlette's ``func(request) -> response`` shape.
_Handler = Callable[[Request], Awaitable[Response]]


def _rate_limited(
    handler: _Handler, *, settings: Settings, namespace: str, value: str
) -> _Handler:
    """Wrap a handler in a per-IP moving window, hit on the shared limiter storage.

    The same mechanism as ``pat_auth._enforce_rate_limit`` (a direct
    ``limiter.limiter.hit``, not a decorator): these are Starlette routes, so there
    is no FastAPI dependency to prime, and the counters stay isolated per app
    instance through ``rate_limit_scope``. The check runs BEFORE the handler, so a
    refused request consumes the bucket too (R8).
    """

    async def wrapped(request: Request) -> Response:
        if settings.rate_limit_enabled:
            scope_prefix: str = getattr(
                request.app.state, "rate_limit_scope", "default"
            )
            key = f"{scope_prefix}:{namespace}:{get_remote_address(request)}"
            for item in parse_many(value):
                if not limiter.limiter.hit(item, key):
                    # The house 429 envelope (AM-I), the same bytes every other
                    # refusal in this API uses.
                    return JSONResponse(
                        {"detail": "RATE_LIMITED"}, status_code=429, headers=_NO_STORE
                    )
        return await handler(request)

    return wrapped


def _form_only(handler: _Handler) -> _Handler:
    """Refuse a non-form body at ``/oauth/token`` with RFC 6749's own error code."""

    async def wrapped(request: Request) -> Response:
        # Lower-cased: a media type is case-insensitive (RFC 9110 §8.3), and
        # refusing "Application/X-WWW-Form-Urlencoded" would invent a break the
        # body parser itself does not have.
        content_type = request.headers.get("content-type", "").lower()
        if not content_type.startswith(_FORM_CONTENT_TYPES):
            return JSONResponse(
                {
                    "error": "invalid_request",
                    "error_description": (
                        "the token endpoint takes application/x-www-form-urlencoded"
                    ),
                },
                status_code=400,
                headers=_NO_STORE,
            )
        return await handler(request)

    return wrapped


class _GrantTokenVerifier(TokenVerifier):
    """``/mcp``'s bearer check: the provider's own ``load_access_token``.

    The SDK ships ``ProviderTokenVerifier``, which does exactly this and nothing
    else, but it is typed against
    ``OAuthAuthorizationServerProvider[AuthorizationCode, RefreshToken,
    AccessToken]`` with INVARIANT type parameters, so our provider — which
    carries its own code and refresh models — is not assignable to it. This is
    the same five lines with the right type, rather than a ``cast`` that would
    silently keep compiling if the SDK's verifier grew a second call.

    What matters is that there is still ONE acceptance path: this goes through
    ``provider.load_access_token`` → ``oauth/tokens.resolve_access_token_row``,
    the very function ``pat_auth`` uses, so "revoked" cannot mean two things.
    """

    def __init__(self, provider: BudgetOAuthProvider) -> None:
        self._provider = provider

    async def verify_token(self, token: str) -> AccessToken | None:
        return await self._provider.load_access_token(token)


def _mcp_endpoint(
    provider: BudgetOAuthProvider,
    urls: PublicUrls,
    manager: StreamableHTTPSessionManager,
) -> ASGIApp:
    """The ``/mcp`` ASGI chain, exactly as the SDK composes it.

    Outside in: authenticate the bearer (``AuthenticationMiddleware`` +
    ``BearerAuthBackend``, which puts an ``AuthenticatedUser`` on
    ``scope["user"]`` and refuses a token minted for another audience), then
    require it (``RequireAuthMiddleware``, which answers 401 with the
    ``WWW-Authenticate`` document pointer), then the transport.

    ``required_scopes=[]`` and that is not an oversight: the mode is a property of
    the GRANT (``read`` vs ``full``) and the only enforcement of it is the API's
    own method gate on the inner request. Requiring a scope here would refuse a
    read connector outright instead of giving it the 20 read tools.

    Both URLs go in as ``AnyHttpUrl`` because the SDK types them that way; the
    comparison against ``AccessToken.resource`` tolerates a trailing slash on
    either side, and neither of these strings has one.
    """
    return AuthenticationMiddleware(
        RequireAuthMiddleware(
            StreamableHTTPASGIApp(manager),
            required_scopes=[],
            resource_metadata_url=AnyHttpUrl(urls.protected_resource_metadata),
        ),
        backend=BearerAuthBackend(
            _GrantTokenVerifier(provider),
            resource_server_url=AnyHttpUrl(urls.resource),
        ),
    )


def oauth_routes(
    app: FastAPI,
    settings: Settings,
    urls: PublicUrls,
    mcp_manager: StreamableHTTPSessionManager,
) -> list[Route]:
    """Every Starlette route of the connector, in the order they are registered."""
    provider = BudgetOAuthProvider(app, settings, urls)
    metadata = _authorization_server_metadata(urls)
    resource_metadata = _protected_resource_metadata(urls)

    authorize = _rate_limited(
        AuthorizationHandler(provider).handle,
        settings=settings,
        namespace="oauth-authorize",
        value=settings.oauth_endpoint_rate_limit,
    )
    token = _form_only(
        _rate_limited(
            TokenHandler(provider, BudgetClientAuthenticator(provider)).handle,
            settings=settings,
            namespace="oauth-token",
            value=settings.oauth_endpoint_rate_limit,
        )
    )
    register = _rate_limited(
        RegistrationHandler(provider, ClientRegistrationOptions(enabled=True)).handle,
        settings=settings,
        namespace="oauth-register",
        value=settings.oauth_register_rate_limit,
    )
    capped_register: ASGIApp = RequestBodyLimitMiddleware(
        request_response(register), REGISTER_MAX_BODY_BYTES
    )

    return [
        # RFC 8414. The path is fixed by the spec and must stay at the root of the
        # public host, which is why nginx proxies ``/.well-known/oauth-`` to the API.
        Route(
            "/.well-known/oauth-authorization-server",
            MetadataHandler(metadata).handle,
            methods=["GET"],
            name="oauth_authorization_server_metadata",
        ),
        # RFC 9728, served at BOTH paths: a client derives the path-inserted one
        # from the resource URL and falls back to the bare one.
        Route(
            "/.well-known/oauth-protected-resource/mcp",
            ProtectedResourceMetadataHandler(resource_metadata).handle,
            methods=["GET"],
            name="oauth_protected_resource_metadata_mcp",
        ),
        Route(
            "/.well-known/oauth-protected-resource",
            ProtectedResourceMetadataHandler(resource_metadata).handle,
            methods=["GET"],
            name="oauth_protected_resource_metadata",
        ),
        Route(
            "/oauth/authorize",
            authorize,
            methods=["GET", "POST"],
            name="oauth_authorize",
        ),
        Route("/oauth/token", token, methods=["POST"], name="oauth_token"),
        # An ASGI object rather than a function, so starlette serves it raw — the
        # body cap has to see the ``http.request`` messages themselves.
        Route(
            "/oauth/register",
            capped_register,
            methods=["POST"],
            name="oauth_register",
        ),
        # A Route, NEVER a Mount (see the module docstring). Its endpoint is an
        # ASGI object, so starlette serves it raw — the transport owns the body
        # and, in SSE mode, the response stream.
        Route(
            "/mcp",
            _mcp_endpoint(provider, urls, mcp_manager),
            methods=["GET", "POST", "DELETE"],
            name="mcp",
        ),
    ]


def _authorization_server_metadata(urls: PublicUrls) -> OAuthMetadata:
    """What ``/.well-known/oauth-authorization-server`` publishes (architecture §D5).

    Built with ``model_validate`` over STRINGS, never from pre-built ``AnyHttpUrl``
    objects: the model's ``url_preserve_empty_path`` only applies while VALIDATING,
    so a pre-built URL would arrive already normalised to ``https://host/`` and the
    issuer would gain a trailing slash Claude reads as a different server.

    No ``scopes_supported`` (the mode is chosen on the consent page, not requested
    on the wire), no ``revocation_endpoint`` (§D7: revocation is Settings) and no
    ``client_id_metadata_document_supported`` (CIMD is deliberately not
    implemented — it would mean fetching an arbitrary https URL inside
    ``/authorize``).
    """
    return OAuthMetadata.model_validate(
        {
            "issuer": urls.issuer,
            "authorization_endpoint": urls.authorize,
            "token_endpoint": urls.token,
            "registration_endpoint": urls.register,
            "response_types_supported": ["code"],
            "grant_types_supported": ["authorization_code", "refresh_token"],
            # Ruling R1: three methods, every secret stored only as a digest.
            "token_endpoint_auth_methods_supported": sorted(ALLOWED_AUTH_METHODS),
            "code_challenge_methods_supported": ["S256"],
        }
    )


def _protected_resource_metadata(urls: PublicUrls) -> ProtectedResourceMetadata:
    """RFC 9728 for ``/mcp``. No ``scopes_supported``, on purpose.

    With no advertised scopes Claude sends no ``scope`` at all, and the token
    response's ``scope`` carries the mode the USER picked — an authorization server
    may narrow, which is exactly what the consent page does.
    """
    return ProtectedResourceMetadata.model_validate(
        {
            "resource": urls.resource,
            "authorization_servers": [urls.issuer],
            "bearer_methods_supported": ["header"],
        }
    )
