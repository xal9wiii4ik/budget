"""The ONE marker that says what a route is to a token and to an AI client.

Three sources of truth used to answer that question — the PAT allowlist literal,
the MCP package's curated tool table and the grooming rule "every endpoint answers
about MCP". They drifted, because nothing made them agree. This module is what
replaced them: a marker sitting immediately above the handler, from which
:mod:`budget_api.mcp.exposure` derives (a) the set of (method, path) pairs a PAT
may reach and (b) the MCP tool list.

Two constructors of the SAME marker:

* :func:`mcp_tool` — the route is reachable by a token AND published as a tool,
  with the curated English prose the model actually reads;
* :func:`pat_reachable` — the route is reachable by a token but is NOT a tool
  (something hand-written calls it), and ``reason`` says why in the code.

An unmarked route is unreachable by a token (403 at the gate) and invisible in
MCP — fail-closed by construction, so forgetting the marker can only close the
surface, never open it. A route that must stay out on purpose carries a
``# MCP: no — <reason>`` comment instead, which costs a reader nothing to find.

SCOPE IS NOT AN ARGUMENT: read ⇔ GET; a departure from that rule is possible only
through an explicit parameter, which deliberately does not exist yet. A GET that
has side effects, or a non-GET that is safe for a read token, is a decision its
author must take deliberately — not inherit in silence by writing ``scope=``. The
runtime gate already decides by method (``pat_auth._WRITE_METHODS``), so a third
column could only disagree with it: a "read" tool on a POST would be published to
a read token and then collect 403s. ``tests/test_mcp_tools.py`` pins both scope
lists name by name.

Metadata lives ONLY on the function: never in ``openapi_extra``, never in a
handler docstring (that is the operation's description in the contract). The
contract is byte-identical with and without this module.
"""

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any, Literal, TypeVar

#: How the MCP server fills a body property the model never sees.
#:
#: ``uuid``: a fresh v4 UUID per logical tool call (idempotency keys).
ManagedBodyValue = Literal["uuid"]

_ATTR = "__mcp_exposure__"

_EMPTY_PARAMS: Mapping[str, str] = MappingProxyType({})
_EMPTY_MANAGED: Mapping[str, ManagedBodyValue] = MappingProxyType({})

F = TypeVar("F", bound=Callable[..., Any])


@dataclass(frozen=True)
class ToolSpec:
    """The product surface of one route: what an AI client sees of it.

    ``method`` and ``path`` are NOT here — they are read off the route the marker
    was found on, so there is nothing for a table to drift from. Neither is
    ``scope`` (see the module docstring).
    """

    name: str
    description: str
    #: Property name → curated description. A name the operation does not accept
    #: fails the tool build; see :mod:`budget_api.mcp.tools`.
    params: Mapping[str, str] = field(default=_EMPTY_PARAMS)
    #: Body properties the MODEL must not see: name → how the server fills them.
    #: They are stripped from the tool's input schema and written into the JSON
    #: body by :mod:`budget_api.mcp.http`.
    managed_body: Mapping[str, ManagedBodyValue] = field(default=_EMPTY_MANAGED)


@dataclass(frozen=True)
class Exposure:
    """What one route is: a tool, or token-reachable with a stated reason."""

    tool: ToolSpec | None = None
    reason: str | None = None


def _mark[F: Callable[..., Any]](fn: F, exposure: Exposure) -> F:
    if getattr(fn, _ATTR, None) is not None:
        raise TypeError(
            f"{fn.__qualname__} already carries an MCP marker — one route, one marker"
        )
    setattr(fn, _ATTR, exposure)
    return fn


def mcp_tool(
    *,
    name: str,
    description: str,
    params: Mapping[str, str] | None = None,
    managed_body: Mapping[str, ManagedBodyValue] | None = None,
) -> Callable[[F], F]:
    """Publish this route as an MCP tool (and let a PAT reach it).

    Put it IMMEDIATELY above ``async def`` — innermost of the decorators. The
    marker survives ``functools.wraps`` (it copies ``__dict__``), so a wrapping
    decorator like the receipts rate limiter keeps it, and ``@router.get`` &
    friends return the same function object.
    """

    spec = ToolSpec(
        name=name,
        description=description,
        params=MappingProxyType(dict(params)) if params else _EMPTY_PARAMS,
        managed_body=(
            MappingProxyType(dict(managed_body)) if managed_body else _EMPTY_MANAGED
        ),
    )

    def decorate(fn: F) -> F:
        return _mark(fn, Exposure(tool=spec))

    return decorate


def pat_reachable(*, reason: str) -> Callable[[F], F]:
    """A PAT may call this route, but it is NOT published as a tool.

    ``reason`` is mandatory: "reachable by a token, invisible to the model" is
    exactly the combination a reader must not have to reconstruct.
    """

    def decorate(fn: F) -> F:
        return _mark(fn, Exposure(reason=reason))

    return decorate


def exposure_of(fn: object) -> Exposure | None:
    """The marker on a handler, or None when it carries none."""
    marker = getattr(fn, _ATTR, None)
    return marker if isinstance(marker, Exposure) else None
