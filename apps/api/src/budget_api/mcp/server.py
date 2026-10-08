"""The MCP server itself (two handlers) and the stdio entry point.

ONE SERVER, TWO TRANSPORTS. :func:`build_server` is shared by this module's
stdio ``serve()`` and by ``mcp/remote.py``'s ``/mcp`` route, and the only thing
that differs between them is WHO is calling: stdio has exactly one caller for the
life of the process, while a remote request carries its own OAuth bearer and its
own mode. That difference is the ``credential`` callable — ``build_server`` asks
it per request and never remembers the answer, so the two handlers below hold no
caller state at all. stdio passes a constant and therefore behaves exactly as it
did before the remote transport existed.

STDOUT BELONGS TO THE TRANSPORT. One stray ``print`` anywhere under
``budget_api.mcp`` corrupts the JSON-RPC stream and the client dies with an
unreadable parse error — every diagnostic here goes to stderr, and
``tests/test_mcp_server.py`` pins that building the app and the tools writes zero
bytes to stdout.

Startup order is deliberate: environment, then the app (which is where the tool
markers live), then the contract bytes, then the tools, then the upload fence,
then ``GET /tokens/self``. Each step fails with a sentence the operator can act
on, because a half-working MCP server looks to the user like a lying assistant
rather than a broken process.

THE TOOLS COME FROM THE APP, NOT FROM A RUNNING API. The curated prose lives on
the handler functions, so the routers have to be imported in any case; taking the
schemas from the same in-process app (through the canonical serializer, so they
are the bytes of ``openapi.json``) means "the code this server read" and "the
surface it publishes" can never be two different versions. It costs one app build
(~1-2 s) per process, once per client session.

Launch: ``uv run --frozen --extra mcp --directory <repo>/apps/api python -m
budget_api.mcp``. ``--extra mcp`` is an empty no-op alias kept for that documented
line (ruling R4): the SDK is a runtime dependency of the package now, because the
API process serves ``/mcp`` itself.
"""

import json
import os
import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass

import httpx
from mcp.server import Server
from mcp.server.context import ServerRequestContext
from mcp.server.stdio import stdio_server
from mcp.types import (
    CallToolRequestParams,
    CallToolResult,
    ListToolsResult,
    PaginatedRequestParams,
    TextContent,
    Tool,
)

from budget_api import __version__
from budget_api.mcp.exposure import tool_specs
from budget_api.mcp.http import (
    ApiConfig,
    ConfigError,
    Err,
    TokenSelf,
    call_tool,
    fetch_token_self,
    read_api_config,
)
from budget_api.mcp.tools import (
    BuiltTool,
    OpenApiError,
    TokenScope,
    ToolBuildError,
    build_tools,
    parse_document,
    tools_for_scope,
)
from budget_api.mcp.truncate import dumps, truncate_response
from budget_api.mcp.upload_receipt import (
    UPLOAD_TOOL_DESCRIPTION,
    UPLOAD_TOOL_INPUT_SCHEMA,
    UPLOAD_TOOL_NAME,
    UploadConfig,
    read_upload_config,
    upload_receipt,
)
from budget_api.openapi_export import build_export_app, openapi_json

SERVER_NAME = "budget"


def log_stderr(message: str) -> None:
    """The ONLY output channel of this process besides the JSON-RPC stream."""
    sys.stderr.write(f"budget-mcp: {message}\n")
    sys.stderr.flush()


def build_published_tools() -> tuple[BuiltTool, ...]:
    """Every tool the markers describe, with schemas from the contract's BYTES.

    ``json.loads(openapi_json(app))`` and never ``app.openapi()``: the in-memory
    document orders object properties by pydantic field order while the committed
    file orders them alphabetically, and the order of ``required`` follows the
    order of ``properties``.
    """
    app = build_export_app()
    document = parse_document(json.loads(openapi_json(app)))
    return build_tools(document, tool_specs(app))


def _describe(tool: BuiltTool) -> Tool:
    return Tool(
        name=tool.name,
        description=tool.description,
        input_schema=tool.input_schema,
    )


def _text_result(text: str, *, is_error: bool = False) -> CallToolResult:
    return CallToolResult(
        content=[TextContent(type="text", text=text)], is_error=is_error
    )


@dataclass(frozen=True)
class ToolCredential:
    """Who is calling and over which HTTP client — resolved per request.

    Frozen on purpose: it is handed to the handlers and must not become a place
    to stash per-call state. On stdio one instance lives for the whole process;
    on ``/mcp`` a fresh one is built from the request's bearer, so nothing about
    one caller can ever be read by the next.
    """

    client: httpx.AsyncClient
    config: ApiConfig
    scope: TokenScope


#: How :func:`build_server` learns who is calling. ``None`` means "no identity on
#: this request" — on ``/mcp`` that is unreachable (the bearer middleware answers
#: 401 first) and is handled as a tool error rather than an exception anyway.
CredentialFor = Callable[[ServerRequestContext[object]], ToolCredential | None]

#: What an unauthenticated call is told. A sentence, not a traceback: a protocol
#: error is something the model cannot read, let alone act on.
NOT_AUTHENTICATED = (
    "This MCP connection is not authenticated — reconnect the AI app to Budget."
)


def offered_tools(
    tools: Sequence[BuiltTool], credential: ToolCredential, upload: UploadConfig
) -> list[Tool]:
    """Exactly what ``tools/list`` answers for this credential.

    The upload tool is hand-written (it touches the filesystem) and is offered
    only when BOTH conditions hold: the caller may write at all, and the user has
    named a folder this server may read. Either missing → the tool does not
    exist, rather than existing and always refusing. Remotely the folder is never
    set, so ``upload_receipt`` is simply not part of the remote surface.
    """
    described = [_describe(tool) for tool in tools_for_scope(tools, credential.scope)]
    if credential.scope == "full" and upload.directory is not None:
        described.append(
            Tool(
                name=UPLOAD_TOOL_NAME,
                description=UPLOAD_TOOL_DESCRIPTION,
                input_schema=UPLOAD_TOOL_INPUT_SCHEMA,
            )
        )
    return described


def build_server(
    tools: Sequence[BuiltTool],
    *,
    credential: CredentialFor,
    upload: UploadConfig,
) -> Server[object]:
    """Wire the two handlers this server has.

    Kept separate from :func:`main` so the in-memory client test drives exactly the
    server the stdio transport would — and so the ``/mcp`` route drives exactly the
    server stdio does, with a different ``credential`` and nothing else.
    """

    async def on_list_tools(
        context: ServerRequestContext[object],
        _params: PaginatedRequestParams | None,
    ) -> ListToolsResult:
        # Resolved per request, never cached: on /mcp two consecutive requests
        # can be two different users with two different modes.
        caller = credential(context)
        if caller is None:
            return ListToolsResult(tools=[])
        return ListToolsResult(tools=offered_tools(tools, caller, upload))

    async def on_call_tool(
        context: ServerRequestContext[object],
        params: CallToolRequestParams,
    ) -> CallToolResult:
        caller = credential(context)
        if caller is None:
            return _text_result(NOT_AUTHENTICATED, is_error=True)
        arguments = params.arguments or {}
        if params.name == UPLOAD_TOOL_NAME and (
            caller.scope == "full" and upload.directory is not None
        ):
            uploaded = await upload_receipt(
                caller.client, caller.config, upload, arguments.get("path")
            )
            if isinstance(uploaded, Err):
                return _text_result(uploaded.message, is_error=True)
            return _text_result(dumps(truncate_response(uploaded.data)))

        # Scoped to what this caller may SEE, so a write tool addressed by name
        # under a read credential is "unknown" rather than refused downstream —
        # the same answer the published list already implies.
        by_name = {tool.name: tool for tool in tools_for_scope(tools, caller.scope)}
        tool = by_name.get(params.name)
        if tool is None:
            return _text_result(f'Unknown tool "{params.name}".', is_error=True)
        result = await call_tool(caller.client, caller.config, tool, arguments)
        if isinstance(result, Err):
            return _text_result(result.message, is_error=True)
        return _text_result(dumps(truncate_response(result.data)))

    server: Server[object] = Server(
        SERVER_NAME,
        version=__version__,
        on_list_tools=on_list_tools,
        on_call_tool=on_call_tool,
    )
    return server


async def serve(env: Mapping[str, str]) -> int:
    """Start up, then hand stdin/stdout to the transport. Returns the exit code."""
    try:
        config = read_api_config(env)
        tools = build_published_tools()
        upload = await read_upload_config(env)
    except (ConfigError, OpenApiError, ToolBuildError) as error:
        # Every expected start-up failure ends in a sentence for the operator, not
        # a traceback: a contract without `paths` is as expected as a bad token.
        log_stderr(str(error))
        return 1

    async with httpx.AsyncClient() as client:
        introspection = await fetch_token_self(client, config)
        if isinstance(introspection, Err):
            log_stderr(introspection.message)
            return 1
        self_token: TokenSelf = introspection

        # ONE credential for the whole process: a stdio server is launched with a
        # single token and serves a single client, so the per-request callable the
        # remote transport needs is a constant here.
        caller = ToolCredential(client=client, config=config, scope=self_token.scope)
        server = build_server(tools, credential=lambda _ctx: caller, upload=upload)
        published_count = len(offered_tools(tools, caller, upload))
        async with stdio_server() as (read_stream, write_stream):
            log_stderr(
                f"ready — {published_count} tools, token scope "
                f'"{self_token.scope}", API {config.base_url}, uploads '
                f"{upload.directory or 'off'}"
            )
            await server.run(
                read_stream, write_stream, server.create_initialization_options()
            )
    return 0


async def main() -> None:
    """Every startup failure arrives already phrased for a human."""
    code = await serve(os.environ)
    if code != 0:
        raise SystemExit(code)
