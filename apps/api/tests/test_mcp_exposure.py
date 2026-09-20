"""The walk over ``app.routes`` — the one thing a fastapi upgrade can break quietly.

Everything the walk PRODUCES is pinned elsewhere: the 38 pairs in
``test_pat_auth.py::TestAllowlistContract``, the 35 tools in ``test_mcp_tools.py``.
What is left here are the two ways the walk ITSELF can go wrong — a route container
it no longer understands, and a container it still understands but which has
stopped meaning what it meant — plus the one property of its output that no other
test sees: the order tools come out in.
"""

from typing import Any

import pytest
from fastapi import FastAPI

from budget_api.mcp.exposure import tool_specs, walk
from budget_api.openapi_export import build_export_app


class TestWalk:
    def test_openapi_pairs_are_a_subset_of_walked_pairs(self) -> None:
        """The walk sees every operation the contract does — or the surface has holes.

        A fastapi upgrade that keeps the route classes but changes what
        ``effective_route_contexts()`` returns (a relative template, a missing
        method, a router that no longer answers) would leave marked routes
        invisible: their pairs would drop out of the PAT allowlist and their tools
        out of the client, with nothing at runtime to say so.
        """
        app = build_export_app()
        paths: dict[str, dict[str, Any]] = app.openapi()["paths"]

        contract = {
            (method.upper(), path)
            for path, operations in paths.items()
            for method in operations
        }

        assert sorted(contract - set(walk(app))) == []

    def test_an_unknown_route_container_fails_the_walk(self) -> None:
        """Fail-closed: an unreadable route object stops create_app, never gets
        skipped. Skipping it silently is the dangerous half — the routes inside
        would keep serving traffic while their markers vanished from the
        derivation."""

        class Mounted:
            path = "/something"

        app = FastAPI()
        app.routes.append(Mounted())  # pyright: ignore[reportArgumentType] - the point

        with pytest.raises(TypeError, match="Mounted"):
            walk(app)

    def test_every_read_tool_precedes_every_write_tool(self) -> None:
        """The order is the order the model reads the tool list in, and only the
        partition in ``tool_specs`` holds it: sorting the specs by name would mix
        writes in among the reads without failing a single membership test."""
        specs = tool_specs(build_export_app())

        reads = [index for index, tool in enumerate(specs) if tool.method == "GET"]
        writes = [index for index, tool in enumerate(specs) if tool.method != "GET"]

        assert reads and writes
        assert reads[-1] < writes[0]
