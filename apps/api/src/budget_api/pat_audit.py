"""PAT audit trail — one ``pat_audit_log`` row per token-authenticated call (§6).

A pure ASGI middleware, not ``BaseHTTPMiddleware``: it needs the raw
``http.response.start`` status and (for a POST) the response bytes, and the ASGI
form gets both by wrapping ``send`` without turning every streamed response into a
buffered one.

Three rules this module exists to keep:

* **It can never fail a request.** The insert runs AFTER the response has been
  sent, on its own short session, and any storage error is logged and swallowed —
  an audit trail that could 500 the API would be a liability, not a control.
* **It stores no user data.** ``path`` is the ROUTE TEMPLATE, so query values and
  request/response bodies never reach the table (architecture §6).
* **It only records real PAT traffic.** ``request.state.pat`` is stashed by
  ``pat_auth`` as the LAST step of a successful authentication, so JWT calls (and
  PAT calls rejected by a gate) write nothing.

``entity_id`` comes from the path parameter for PATCH/PUT/DELETE — a 204 has no
body at all, so the path is the only source — and from the response ``id`` for a
2xx POST, which is the one case where the body is buffered.
"""

import json
import logging
import uuid
from typing import Any, cast

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from budget_api.models import PatAuditLog
from budget_api.pat_auth import PatContext, route_template

logger = logging.getLogger(__name__)

#: Writes whose affected entity is named by the URL. A POST names it in the body
#: of its own response instead.
_PATH_ENTITY_METHODS = frozenset({"PATCH", "PUT", "DELETE"})
#: Ceiling on the buffered POST body. Every allowlisted POST returns one small
#: entity; the cap is only there so a future large-response route cannot turn this
#: middleware into a memory amplifier (a bigger body simply yields no entity_id).
_MAX_CAPTURED_BODY = 64 * 1024
#: ``pat_audit_log.path`` is String(200); route templates are far shorter, but a
#: truncating slice is cheaper than an insert that raises.
_PATH_MAX = 200
#: What is audited when the route template cannot be resolved. A placeholder, never
#: the raw URL: query strings carry user data and this table stores none.
_UNRESOLVED_PATH = "<unresolved>"


def _path_entity_id(scope: Scope) -> uuid.UUID | None:
    """The single uuid path parameter of a PATCH/PUT/DELETE route, if any.

    Starlette's default path convertor is ``str`` — FastAPI coerces to ``uuid.UUID``
    at the Pydantic layer, not in ``scope["path_params"]`` — so the raw value is
    parsed here rather than type-checked.
    """
    params: dict[str, Any] = scope.get("path_params") or {}
    for value in params.values():
        if isinstance(value, uuid.UUID):
            return value
        if isinstance(value, str):
            try:
                return uuid.UUID(value)
            except ValueError:
                continue
    return None


def _body_entity_id(body: bytes) -> uuid.UUID | None:
    """The ``id`` of a 2xx POST response body, if it is a uuid."""
    try:
        payload: Any = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    raw: Any = cast("dict[str, Any]", payload).get("id")
    if not isinstance(raw, str):
        return None
    try:
        return uuid.UUID(raw)
    except ValueError:
        return None


async def _insert_audit_row(
    sessionmaker: async_sessionmaker[AsyncSession], row: PatAuditLog
) -> None:
    """Own short session — the request's session is long closed by now."""
    async with sessionmaker() as session:
        session.add(row)
        await session.commit()


class PatAuditMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        status_code = 0
        capture = False
        captured = bytearray()

        async def send_wrapper(message: Message) -> None:
            nonlocal status_code, capture
            if message["type"] == "http.response.start":
                status_code = message["status"]
                # Decided HERE, not up front: by response-start the auth dependency
                # has run, so we buffer only for a PAT POST that actually succeeded
                # — no other traffic (least of all a stream) is ever accumulated.
                capture = (
                    scope["method"] == "POST"
                    and 200 <= status_code < 300
                    and _pat_of(scope) is not None
                )
            elif message["type"] == "http.response.body" and capture:
                if len(captured) < _MAX_CAPTURED_BODY:
                    captured.extend(message.get("body", b""))
            await send(message)

        await self.app(scope, receive, send_wrapper)

        pat = _pat_of(scope)
        if pat is None:
            return

        # The same resolver the allowlist gate used, so the audited path is
        # exactly the template that was authorised. The fallback is a constant, NOT
        # scope["path"]: a raw URL carries query values, i.e. user data, and this
        # table never stores any (architecture §6).
        path = route_template(scope) or _UNRESOLVED_PATH
        method: str = scope["method"]
        if method in _PATH_ENTITY_METHODS:
            entity_id = _path_entity_id(scope)
        elif capture:
            entity_id = _body_entity_id(bytes(captured))
        else:
            entity_id = None

        row = PatAuditLog(
            token_id=pat.id,
            user_id=pat.user_id,
            method=method,
            path=str(path)[:_PATH_MAX],
            status_code=status_code,
            entity_id=entity_id,
        )
        try:
            await _insert_audit_row(scope["app"].state.sessionmaker, row)
        except Exception as exc:
            # NEVER propagate, and deliberately for EVERY exception class: the
            # response is already on the wire, so nothing here can still be reported
            # to the client, and no failure mode of the audit writer may be able to
            # take a served request down (architecture §6).
            logger.warning(
                "pat audit insert failed (%s %s, token=%s): %r",
                method,
                path,
                pat.id,
                exc,
            )


def _pat_of(scope: Scope) -> PatContext | None:
    """The PatContext ``pat_auth`` stashed on ``request.state``, if this is a PAT call.

    ``request.state`` is backed by ``scope["state"]``, so the dependency's stash is
    visible here through the same scope dict — no second lookup mechanism.
    """
    state: dict[str, Any] = scope.get("state") or {}
    pat: Any = state.get("pat")
    return pat if isinstance(pat, PatContext) else None
