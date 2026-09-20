"""stdio entry point for the Budget MCP server.

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
budget_api.mcp``. The SDK is an optional extra (``[project.optional-dependencies]``)
— the API image is built without it, so ``--extra mcp`` is part of the command
rather than a convenience.
"""

import json
import os
import sys
from collections.abc import Mapping

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


def build_server(
    client: httpx.AsyncClient,
    config: ApiConfig,
    tools: tuple[BuiltTool, ...],
    upload: UploadConfig,
    scope: TokenScope,
) -> tuple[Server[object], int]:
    """Wire the two handlers this server has, and say how many tools it publishes.

    Kept separate from :func:`main` so the in-memory client test drives exactly the
    server the stdio transport would.
    """
    published = tools_for_scope(tools, scope)
    by_name = {tool.name: tool for tool in published}

    # The upload tool is hand-written (it touches the filesystem) and is offered
    # only when BOTH conditions hold: the token may write at all, and the user has
    # named a folder this server may read. Either missing → the tool does not
    # exist, rather than existing and always refusing.
    upload_offered = scope == "full" and upload.directory is not None
    local_tools = (
        [
            Tool(
                name=UPLOAD_TOOL_NAME,
                description=UPLOAD_TOOL_DESCRIPTION,
                input_schema=UPLOAD_TOOL_INPUT_SCHEMA,
            )
        ]
        if upload_offered
        else []
    )

    async def on_list_tools(
        _context: ServerRequestContext[object],
        _params: PaginatedRequestParams | None,
    ) -> ListToolsResult:
        return ListToolsResult(tools=[_describe(t) for t in published] + local_tools)

    async def on_call_tool(
        _context: ServerRequestContext[object],
        params: CallToolRequestParams,
    ) -> CallToolResult:
        arguments = params.arguments or {}
        if params.name == UPLOAD_TOOL_NAME and upload_offered:
            uploaded = await upload_receipt(
                client, config, upload, arguments.get("path")
            )
            if isinstance(uploaded, Err):
                return _text_result(uploaded.message, is_error=True)
            return _text_result(dumps(truncate_response(uploaded.data)))

        tool = by_name.get(params.name)
        if tool is None:
            return _text_result(f'Unknown tool "{params.name}".', is_error=True)
        result = await call_tool(client, config, tool, arguments)
        if isinstance(result, Err):
            return _text_result(result.message, is_error=True)
        return _text_result(dumps(truncate_response(result.data)))

    server: Server[object] = Server(
        SERVER_NAME,
        version=__version__,
        on_list_tools=on_list_tools,
        on_call_tool=on_call_tool,
    )
    return server, len(published) + len(local_tools)


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

        server, published_count = build_server(
            client, config, tools, upload, self_token.scope
        )
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
