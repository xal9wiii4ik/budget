"""One walk over ``app.routes``, three consumers: the gate, the tests, the server.

The markers of :mod:`budget_api.mcp.decorator` sit on handler functions; this is
where they become data. :func:`pat_allowlist` gives ``current_user_jwt_or_pat``
the exact set of (method, template) pairs a personal access token may reach, and
:func:`tool_specs` gives the MCP server its tool list — both derived from the SAME
markers in the SAME order, so "reachable by a token" and "visible to the model"
can no longer disagree.

Since fastapi 0.139 ``include_router`` MOUNTS the sub-router instead of copying its
routes, so ``app.routes`` holds router containers, not the routes themselves, and
the full (prefixed) template lives on the effective route context — the same object
``pat_auth.route_template`` reads at request time. The container class is private,
so it is matched structurally (:class:`RouterLike`) rather than imported.

FAIL-CLOSED ON BOTH SIDES. An unmarked route yields no pair: a token cannot reach
a route nobody decided about. A route object of an unknown kind raises
:class:`TypeError` and takes ``create_app`` down with it, because the alternative —
silently walking past a container a framework upgrade introduced — would drop pairs
from the allowlist and tools from the client with nothing to notice it.

HEAD and OPTIONS are excluded explicitly: starlette adds HEAD to every GET route,
and a HEAD pair in the allowlist would widen a token's surface past the set that was
reviewed pair by pair (tests/test_pat_auth.py::TestAllowlistContract).
"""

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable

from fastapi import FastAPI
from starlette.routing import Route

from budget_api.mcp.decorator import Exposure, ToolSpec, exposure_of

#: Never a pair of their own: HEAD is starlette's free companion of every GET, and
#: OPTIONS is CORS preflight — neither is an operation in the contract.
_IGNORED_METHODS = frozenset({"HEAD", "OPTIONS"})


@runtime_checkable
class RouteContextLike(Protocol):
    """The effective route context: a route as it is AFTER being mounted."""

    @property
    def path_format(self) -> str: ...

    @property
    def methods(self) -> Iterable[str] | None: ...

    @property
    def endpoint(self) -> Callable[..., Any]: ...


@runtime_checkable
class RouterLike(Protocol):
    """A mounted router: fastapi's private ``_IncludedRouter``, matched by shape."""

    def effective_route_contexts(self) -> Iterable[RouteContextLike]: ...


@dataclass(frozen=True)
class RouteExposure:
    """One (method, template) pair together with the marker found on its handler."""

    method: str
    path: str
    endpoint: Callable[..., Any]
    exposure: Exposure


@dataclass(frozen=True)
class RouteTool:
    """A tool as the route defines it: the curated spec plus where it is served."""

    method: str
    path: str
    spec: ToolSpec


def _methods(methods: Iterable[str] | None) -> list[str]:
    return sorted(m for m in (methods or ()) if m not in _IGNORED_METHODS)


def _contexts(app: FastAPI) -> Iterable[tuple[str, str, Callable[..., Any]]]:
    """Every (method, full template, handler) the app serves, in mount order."""
    for route in app.routes:
        if isinstance(route, RouterLike):
            for context in route.effective_route_contexts():
                for method in _methods(context.methods):
                    yield method, context.path_format, context.endpoint
        elif isinstance(route, Route):
            for method in _methods(route.methods):
                yield method, route.path_format, route.endpoint
        else:
            raise TypeError(
                "budget_api.mcp.exposure cannot read route object "
                f"{type(route).__name__!r} ({getattr(route, 'path', '?')!r}) — teach "
                "the walk about it rather than letting its routes fall out of the "
                "PAT allowlist and the MCP tool list unnoticed"
            )


def walk(app: FastAPI) -> tuple[tuple[str, str], ...]:
    """EVERY (method, template) pair the app serves — marked or not.

    The tripwire of the walk itself: the pairs of ``app.openapi()["paths"]`` must be
    a subset of these (tests/test_mcp_exposure.py). A framework upgrade that keeps
    the route classes but changes their semantics shows up there.
    """
    return tuple((method, path) for method, path, _ in _contexts(app))


def collect(app: FastAPI) -> tuple[RouteExposure, ...]:
    """The marked routes only, in mount order."""
    found: list[RouteExposure] = []
    for method, path, endpoint in _contexts(app):
        exposure = exposure_of(endpoint)
        if exposure is not None:
            found.append(RouteExposure(method, path, endpoint, exposure))
    return tuple(found)


def pat_allowlist(app: FastAPI) -> frozenset[tuple[str, str]]:
    """The PAT surface: every marked pair, whether or not it is also a tool."""
    return frozenset((route.method, route.path) for route in collect(app))


def tool_specs(app: FastAPI) -> tuple[RouteTool, ...]:
    """The tools, in mount order (the order is display-only; names are the identity)."""
    return tuple(
        RouteTool(route.method, route.path, route.exposure.tool)
        for route in collect(app)
        if route.exposure.tool is not None
    )
