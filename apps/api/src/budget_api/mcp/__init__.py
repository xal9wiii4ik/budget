"""MCP surface of the API: the route markers, their derivation, and the server.

Deliberately EMPTY: importing ``budget_api.mcp`` must pull in neither the ``mcp``
SDK nor the application, so a router can import :mod:`budget_api.mcp.decorator`
(stdlib only) without dragging the server's dependencies into every request path.
"""
