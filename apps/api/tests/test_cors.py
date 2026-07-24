"""CORS preflight contract (AM-9): allowed origins get the header, others don't."""

from httpx import AsyncClient


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
                "Origin": "http://localhost:5173",
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

        assert allowed.headers.get("access-control-allow-origin") == (
            "http://localhost:5173"
        )
        assert "access-control-allow-origin" not in denied.headers
