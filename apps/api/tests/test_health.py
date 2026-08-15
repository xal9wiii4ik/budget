"""GET /health contract — real DB up (200) and unreachable DB (503, prompt)."""

import time

from asgi_lifespan import LifespanManager
from httpx import ASGITransport, AsyncClient

from budget_api.app import create_app
from budget_api.config import Settings

# Nothing is listening here — a closed local port refuses instantly.
UNREACHABLE_DATABASE_URL = "postgresql+asyncpg://budget:budget@localhost:5599/budget"


class TestHealth:
    async def test_health_ok(self, client: AsyncClient) -> None:
        response = await client.get("/health")

        assert response.status_code == 200
        assert response.json() == {"status": "ok", "database": "ok"}

    async def test_health_db_unavailable(self, test_jwt_secret: str) -> None:
        app = create_app(
            Settings(
                database_url=UNREACHABLE_DATABASE_URL,
                jwt_secret=test_jwt_secret,
                # This is the one app not built through make_client, so the D3
                # scheduler gate is set here by hand: no pytest app ever starts the
                # scheduler (and this one would also boot-probe the dead DB).
                fx_scheduler_enabled=False,
            )
        )
        async with LifespanManager(app):
            transport = ASGITransport(app=app)
            async with AsyncClient(
                transport=transport, base_url="http://test"
            ) as http_client:
                start = time.monotonic()
                response = await http_client.get("/health")
                elapsed = time.monotonic() - start

        assert response.status_code == 503
        assert response.json() == {"status": "degraded", "database": "unavailable"}
        assert elapsed < 5
