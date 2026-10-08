"""The thin HTTP layer: a BuiltTool plus arguments becomes ONE Budget API call.

API failures are RETURNED, never raised: an MCP tool error puts the reason in
front of the model, which can then fix the call itself. A raised exception would
only surface as a protocol error the model cannot read. The wording of every
message is ported from the TypeScript server — it is what the user ends up
reading in the chat.

No money arithmetic happens here and none ever should: bodies pass through as the
model sent them, totals and conversions are the API's (docs/conventions.md).
"""

import json
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import quote

import httpx

from budget_api.mcp.decorator import ManagedBodyValue
from budget_api.mcp.tools import (
    BuiltTool,
    JsonObject,
    TokenScope,
    as_array,
    as_object,
)

DEFAULT_API_URL = "http://localhost:8010"
#: Same 30 s the TypeScript server used, and the same sentence when it expires.
TIMEOUT_SECONDS = 30.0


@dataclass(frozen=True)
class ApiConfig:
    """Where the API is and what authenticates us; ``base_url`` has no slash."""

    base_url: str
    token: str


class ConfigError(Exception):
    """Missing or unusable environment — a startup failure, not a tool failure."""


def read_api_config(env: Mapping[str, str]) -> ApiConfig:
    token = (env.get("BUDGET_PAT") or "").strip()
    if not token:
        raise ConfigError(
            "BUDGET_PAT is not set — issue a personal access token in the web app "
            "(Settings; the value is shown exactly once) and pass it to this server "
            "as BUDGET_PAT."
        )
    base_url = (env.get("BUDGET_API_URL") or "").strip() or DEFAULT_API_URL
    return ApiConfig(base_url=base_url.rstrip("/"), token=token)


@dataclass(frozen=True)
class Ok:
    """A call that went through; ``data`` is the parsed JSON body (or None)."""

    data: Any


@dataclass(frozen=True)
class Err:
    """A call that did not; ``message`` is what the model gets to read."""

    message: str


ApiResult = Ok | Err

#: Detail codes worth translating. Everything else is passed through verbatim —
#: an unknown code is more useful to the model than a guessed paraphrase.
CODE_MESSAGES: Mapping[str, str] = {
    "TOKEN_INVALID": (
        "The API token is invalid or revoked — issue a new token in the web app "
        "(Settings) and update BUDGET_PAT."
    ),
    # ONE sentence for BOTH transports (ruling R5): a stdio server holds a
    # personal access token the user can re-issue, a remote connector holds an
    # OAuth grant whose mode was picked on the consent page, and this text is
    # read by a model that has no idea which of the two it is running as.
    "TOKEN_SCOPE_READONLY": (
        "This connection is read-only — issue a `full` token in the web app "
        "(Settings), or reconnect the AI app choosing full access."
    ),
    "TOKEN_ENDPOINT_FORBIDDEN": "That endpoint is not available to API tokens.",
    "RATE_LIMITED": "Too many API calls — wait a minute before trying again.",
}


#: Told apart from a body that IS the JSON value ``null``.
_UNPARSEABLE = object()


def _parse_json(text: str) -> Any:
    try:
        return json.loads(text)
    except ValueError:
        return _UNPARSEABLE


def _format_validation_errors(detail: list[Any]) -> str | None:
    lines: list[str] = []
    for entry in detail:
        record = as_object(entry)
        if record is None:
            return None
        message = record.get("msg")
        if not isinstance(message, str):
            return None
        raw_loc = as_array(record.get("loc"))
        loc = ".".join(str(part) for part in raw_loc) if raw_loc else "request"
        lines.append(f"  - {loc}: {message}")
    if not lines:
        return None
    return "The Budget API rejected the arguments:\n" + "\n".join(lines)


def describe_api_error(status: int, text: str) -> str:
    """Turn a non-2xx answer into one sentence a model can act on."""
    body = as_object(_parse_json(text))  # _UNPARSEABLE is not an object either
    detail: Any = body.get("detail") if body is not None else None

    if isinstance(detail, str):
        mapped = CODE_MESSAGES.get(detail)
        if mapped is not None:
            return mapped
        # No-oracle: "not yours" and "does not exist" answer identically on
        # purpose, and this text must not split them apart either.
        if detail.endswith("_NOT_FOUND"):
            return f"{detail}: not found (it does not exist, or it is not yours)."
        return f"The Budget API rejected the call (HTTP {status}): {detail}"
    detail_list = as_array(detail)
    if detail_list is not None:
        formatted = _format_validation_errors(detail_list)
        if formatted is not None:
            return formatted
    if status == 429:
        return CODE_MESSAGES["RATE_LIMITED"]
    body_text = "(empty body)" if text.strip() == "" else text[:500]
    return f"The Budget API returned HTTP {status}: {body_text}"


def describe_transport_failure(error: Exception, base_url: str) -> str:
    if isinstance(error, httpx.TimeoutException):
        return (
            f"The Budget API at {base_url} did not answer within "
            f"{int(TIMEOUT_SECONDS)}s."
        )
    return f"Cannot reach the Budget API at {base_url} — is the server running?"


async def send(
    client: httpx.AsyncClient,
    config: ApiConfig,
    method: str,
    url: str,
    *,
    params: Mapping[str, str] | None = None,
    body: JsonObject | None = None,
) -> ApiResult:
    """One request, one answer — transport failures included, never raised."""
    headers = {
        "authorization": f"Bearer {config.token}",
        "accept": "application/json",
    }
    try:
        response = await client.request(
            method.upper(),
            url,
            params=dict(params) if params else None,
            json=body,
            headers=headers,
            timeout=TIMEOUT_SECONDS,
        )
    except httpx.HTTPError as error:
        return Err(describe_transport_failure(error, config.base_url))

    text = response.text
    if 200 <= response.status_code < 300:
        if text.strip() == "":
            return Ok(None)
        data = _parse_json(text)
        if data is _UNPARSEABLE:
            return Err(
                "The Budget API returned a non-JSON body "
                f"(HTTP {response.status_code})."
            )
        return Ok(data)
    return Err(describe_api_error(response.status_code, text))


def _managed_value(kind: ManagedBodyValue) -> str:
    if kind == "uuid":
        return str(uuid.uuid4())


def build_request_body(tool: BuiltTool, args: Mapping[str, Any]) -> JsonObject | None:
    """The JSON body for ONE call: the model's arguments plus what the server owns.

    The managed values are produced HERE, once per logical tool call, so every HTTP
    attempt made for that call carries the same value. That is what makes
    ``create_transaction`` safe to replay: the API matches the ``client_id`` it
    already stored and returns the saved transaction instead of writing a second
    one. A NEW call from the model gets a NEW id on purpose — two deliberate calls
    are two transactions, and the tool description is what stops the model from
    making the second one.
    """
    if not tool.body_props and not tool.managed_body:
        return None

    body: JsonObject = {}
    for name in tool.body_props:
        # Omitted stays omitted: for a PATCH that is "keep the current value".
        # What the model DID send is forwarded as it is, null included — the API
        # is the one that decides whether a null is acceptable there.
        if name in args:
            body[name] = args[name]
    for name, kind in tool.managed_body.items():
        body[name] = _managed_value(kind)
    return body


def _query_value(value: Any) -> str:
    # `True` is not a query value any API accepts by accident — the contract's
    # booleans are lowercase, exactly as the TypeScript server sent them.
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


async def call_tool(
    client: httpx.AsyncClient,
    config: ApiConfig,
    tool: BuiltTool,
    args: Mapping[str, Any],
) -> ApiResult:
    """Fill ``{placeholders}``, build the query string, split off the JSON body."""
    path = tool.path
    for name in tool.path_params:
        value = args.get(name)
        if value is None:
            return Err(f'Missing required argument "{name}".')
        path = path.replace(f"{{{name}}}", quote(str(value), safe=""))

    params: dict[str, str] = {}
    for name in tool.query_params:
        value = args.get(name)
        if value is None:
            continue
        params[name] = _query_value(value)

    return await send(
        client,
        config,
        tool.method,
        config.base_url + path,
        params=params,
        body=build_request_body(tool, args),
    )


@dataclass(frozen=True)
class TokenSelf:
    """What ``GET /tokens/self`` says about the token this process carries."""

    id: str
    scope: TokenScope


async def fetch_token_self(
    client: httpx.AsyncClient, config: ApiConfig
) -> TokenSelf | Err:
    """Startup self-introspection: validates the token AND says what to publish.

    The only ``/tokens/*`` route a token may call (``@pat_reachable`` in
    routers/tokens.py).
    """
    result = await send(client, config, "get", f"{config.base_url}/tokens/self")
    if isinstance(result, Err):
        return result

    record = as_object(result.data) or {}
    token_id: Any = record.get("id")
    scope: Any = record.get("scope")
    if not isinstance(token_id, str) or scope not in ("read", "full"):
        return Err(
            "GET /tokens/self did not answer with {id, scope} — BUDGET_API_URL may "
            "point at something other than the Budget API, or the API predates "
            "personal access tokens."
        )
    literal_scope: Literal["read", "full"] = "read" if scope == "read" else "full"
    return TokenSelf(id=token_id, scope=literal_scope)
