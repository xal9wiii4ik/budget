"""CORS preflight contract (AM-9): allowed origins get the header, others don't."""

from httpx import AsyncClient

from budget_api.openapi_export import build_export_app

_ALLOWED_ORIGIN = "http://localhost:5173"
# Path-item keys that are not operations (OpenAPI 3.1 Path Item Object).
_NON_OPERATION_KEYS = frozenset({"summary", "description", "servers", "parameters"})


def _served_verbs() -> set[str]:
    """Every HTTP verb the API actually routes, read off the schema it publishes.

    Derived from the hermetic export app (no DB, no env) rather than hand-listed,
    so a route added with a brand-new verb widens this set by itself.
    """
    return {
        method.upper()
        for path_item in build_export_app().openapi()["paths"].values()
        for method in path_item
        if method not in _NON_OPERATION_KEYS
    }


class TestCors:
    async def test_preflight_allows_configured_origin_only(
        self, client: AsyncClient
    ) -> None:
        """A preflight from the vite dev origin is granted; a stranger origin is not.

        Config-level and genuinely breakable: a mis-wired allow_origins would either
        echo every origin (leak) or none (browser blocks the app), so both branches
        are asserted against the same real route.
        """
        allowed = await client.options(
            "/auth/login",
            headers={
                "Origin": _ALLOWED_ORIGIN,
                "Access-Control-Request-Method": "POST",
            },
        )
        denied = await client.options(
            "/auth/login",
            headers={
                "Origin": "http://evil.example.com",
                "Access-Control-Request-Method": "POST",
            },
        )

        assert allowed.headers.get("access-control-allow-origin") == _ALLOWED_ORIGIN
        assert "access-control-allow-origin" not in denied.headers

    async def test_preflight_allows_every_verb_the_api_serves(
        self, client: AsyncClient
    ) -> None:
        """allow_methods must cover the whole route table, not yesterday's part of it.

        This is a live blocker, not a hypothetical: PUT /limits/{category_id} shipped
        while allow_methods still ended at DELETE, so every browser preflight for it
        got 400 "Disallowed CORS method" and budgets could not be saved at all. The
        hand-maintained list sits far from the routers that grow, so the next new
        verb fails here instead of in a browser.
        """
        rejected: list[str] = []
        for verb in sorted(_served_verbs()):
            response = await client.options(
                "/limits/00000000-0000-0000-0000-000000000000",
                headers={
                    "Origin": _ALLOWED_ORIGIN,
                    "Access-Control-Request-Method": verb,
                },
            )
            if response.status_code != 200:
                rejected.append(f"{verb} -> {response.status_code} {response.text}")

        assert rejected == [], (
            "verbs the API routes but CORS rejects at preflight — add them to "
            f"allow_methods in create_app: {rejected}"
        )
