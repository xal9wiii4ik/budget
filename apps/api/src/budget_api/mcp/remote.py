"""The remote transport: the stdio server's tool table, served over ``/mcp``.

Three choices make this module small, and each is the point:

* **The tools come from THE RUNNING APP.** ``openapi_json(app)`` is the canonical
  serializer — the exact bytes of ``apps/api/openapi.json`` — so the schemas a
  remote client sees are the schemas the contract names, taken from the app that
  is about to serve the calls. No second app instance (the stdio path builds one
  because it has no app), no file read, no codegen.
* **A tool call is an ordinary request back into the same app**, through
  ``httpx.ASGITransport``, carrying the CALLER's OAuth bearer. So the PAT
  allowlist, the scope gate, the per-grant rate limits, the ``pat_audit_log`` row
  and the no-oracle 404 bodies are all produced by the real request path rather
  than re-implemented here. ``raise_app_exceptions=False`` on that transport is
  mandatory (``app.py`` sets it): an inner 500 has to come back as text the model
  can read, not as an exception inside the JSON-RPC handler.
* **Stateless, JSON responses.** Each POST is one self-contained JSON-RPC
  request: nothing is remembered between requests, so two consecutive calls may
  be two different users and there is no session to pin to a credential. Claude's
  connector works this way and it is the only shape that survives a restart of a
  single-container deployment.

``upload_receipt`` is deliberately NOT offered remotely: it reads a path on the
MCP server's filesystem, which here is the API container's — the user's Mac is
nowhere near it. The gate needs no special case, ``UploadConfig(directory=None)``
already means "no such tool" (``mcp/server.py``).
"""

import json

import httpx
from fastapi import FastAPI
from mcp.server import Server
from mcp.server.auth.middleware.bearer_auth import AuthenticatedUser
from mcp.server.context import ServerRequestContext
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from starlette.requests import Request

from budget_api.mcp.exposure import tool_specs
from budget_api.mcp.http import ApiConfig
from budget_api.mcp.server import ToolCredential, build_server
from budget_api.mcp.tools import TokenScope, build_tools, parse_document
from budget_api.mcp.upload_receipt import UploadConfig
from budget_api.openapi_export import openapi_json

#: The host of every inner tool call. ``ASGITransport`` never resolves it — the
#: request goes straight into the app object — but httpx needs an absolute URL,
#: and this name says in a traceback what happened.
INTERNAL_BASE_URL = "http://budget.internal"

#: Remote callers get the contract's tools and nothing else (see the docstring).
_NO_UPLOAD = UploadConfig(directory=None)


def _mode_of(user: AuthenticatedUser) -> TokenScope | None:
    """The grant's mode, which ``provider.load_access_token`` put in ``scopes``.

    Read back as a literal rather than cast: the wire ``scope`` of an OAuth
    request is advisory in this server (the mode is decided on the consent page),
    so anything other than the two modes we issue is treated as no identity at
    all instead of being trusted as one.
    """
    mode = user.access_token.scopes[0] if user.access_token.scopes else ""
    if mode == "read":
        return "read"
    if mode == "full":
        return "full"
    return None


def build_remote(app: FastAPI) -> tuple[Server[object], StreamableHTTPSessionManager]:
    """The MCP server and the session manager behind the ``/mcp`` route.

    Called once, from ``create_app``, and only when the deployment has a public
    base URL. The manager's ``run()`` is entered by the lifespan; the ASGI chain
    that authenticates it is assembled in ``oauth/routes.py``, where the OAuth
    provider that verifies the bearer already lives.
    """
    document = parse_document(json.loads(openapi_json(app)))
    tools = build_tools(document, tool_specs(app))

    def credential(
        context: ServerRequestContext[object],
    ) -> ToolCredential | None:
        """Who is calling THIS request — the SDK attaches the Starlette request
        to every streamable-HTTP message, and ``RequireAuthMiddleware`` has
        already refused anything without a live bearer, so the lookups below are
        defence in depth rather than a branch that is expected to be taken."""
        request = context.request
        if not isinstance(request, Request):
            return None
        user = request.scope.get("user")
        if not isinstance(user, AuthenticatedUser):
            return None
        mode = _mode_of(user)
        if mode is None:
            return None
        client = getattr(app.state, "mcp_api_client", None)
        if not isinstance(client, httpx.AsyncClient):
            return None
        return ToolCredential(
            client=client,
            # The caller's own bearer, forwarded verbatim: the inner request is
            # authenticated as the user, by the one resolver pat_auth uses.
            config=ApiConfig(base_url=INTERNAL_BASE_URL, token=user.access_token.token),
            scope=mode,
        )

    server = build_server(tools, credential=credential, upload=_NO_UPLOAD)
    manager = StreamableHTTPSessionManager(
        server,
        stateless=True,
        json_response=True,
    )
    return server, manager
