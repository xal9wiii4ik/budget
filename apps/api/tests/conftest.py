"""Shared fixtures: real Postgres (budget_test), lifespan-managed httpx client.

Tests hit a real Postgres — the whole point at 0.2 is proving the production
session path, so nothing here is mocked.
"""

import asyncio
import os
from collections.abc import AsyncIterator

import pytest
from asgi_lifespan import LifespanManager
from httpx import ASGITransport, AsyncClient
from sqlalchemy.exc import SQLAlchemyError

from budget_api.app import create_app
from budget_api.config import Settings
from budget_api.db import build_engine

DEFAULT_TEST_DATABASE_URL = (
    "postgresql+asyncpg://budget:budget@localhost:5433/budget_test"
)


@pytest.fixture(scope="session")
def test_database_url() -> str:
    return os.environ.get("TEST_DATABASE_URL", DEFAULT_TEST_DATABASE_URL)


@pytest.fixture(scope="session", autouse=True)
def _require_test_db(test_database_url: str) -> None:
    """Fail fast with a clear message if the test Postgres is unreachable.

    Sync fixture running a one-shot probe on its own loop via asyncio.run — this
    keeps the session-scoped check off pytest-asyncio's function-scoped runner.
    Probes via build_engine so the 2s connect cap applies (amendment A6): a
    black-holed DB must fail fast, not hang toward asyncpg's 60s default.
    """

    async def _probe() -> None:
        engine = build_engine(Settings(database_url=test_database_url))
        try:
            async with engine.connect():
                pass
        finally:
            await engine.dispose()

    try:
        asyncio.run(_probe())
    except (SQLAlchemyError, OSError) as exc:
        pytest.exit(
            f"test Postgres unreachable ({exc}) — run: docker compose up -d postgres",
            returncode=1,
        )


@pytest.fixture
async def client(test_database_url: str) -> AsyncIterator[AsyncClient]:
    app = create_app(Settings(database_url=test_database_url))
    async with LifespanManager(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(
            transport=transport, base_url="http://test"
        ) as http_client:
            yield http_client
