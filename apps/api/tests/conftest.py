"""Shared fixtures: real Postgres (budget_test), lifespan-managed httpx client.

Tests hit a real Postgres — the whole point is proving the production session path,
so nothing here is mocked. The test schema is produced by running the real
migrations via a subprocess (``alembic upgrade head``) so tests validate migration
0001 itself, and the subprocess sidesteps the ``asyncio.run`` in ``alembic/env.py``
clashing with pytest's running loop (plan §13.8).
"""

import asyncio
import os
import subprocess
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from contextlib import AsyncExitStack
from pathlib import Path
from typing import Any

import pytest
from asgi_lifespan import LifespanManager
from helpers import build_credo_xlsx
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.app import create_app
from budget_api.config import Settings
from budget_api.db import build_engine, build_sessionmaker
from budget_api.llm import LLMProvider
from budget_api.services.push_sender import PushSender

# 5443 is OUR Postgres (docker-compose). 5433 — the port this default used to
# name — belongs to an UNRELATED service on this machine, and the suite creates
# and drops `budget_test` on whatever it reaches: a default pointing at a
# stranger's database is one matching password away from doing that to them.
DEFAULT_TEST_DATABASE_URL = (
    "postgresql+asyncpg://budget:budget@localhost:5443/budget_test"
)
# Any non-empty value works — tests never verify a real secret, only that signing
# and verification round-trip within one app instance.
TEST_JWT_SECRET = "test-jwt-secret-not-a-real-secret"

_API_DIR = Path(__file__).parent.parent


def _settings(test_database_url: str, **overrides: object) -> Settings:
    return Settings(
        database_url=test_database_url,
        jwt_secret=TEST_JWT_SECRET,
        **overrides,  # type: ignore[arg-type]
    )


@pytest.fixture(scope="session")
def test_database_url() -> str:
    return os.environ.get("TEST_DATABASE_URL", DEFAULT_TEST_DATABASE_URL)


@pytest.fixture(scope="session")
def test_jwt_secret() -> str:
    return TEST_JWT_SECRET


@pytest.fixture(scope="session", autouse=True)
def _require_test_db(test_database_url: str) -> None:
    """Fail fast with a clear message if the test Postgres is unreachable.

    Sync fixture running a one-shot probe on its own loop via asyncio.run — this
    keeps the session-scoped check off pytest-asyncio's function-scoped runner.
    Probes via build_engine so the 2s connect cap applies: a black-holed DB must
    fail fast, not hang toward asyncpg's 60s default.
    """

    async def _probe() -> None:
        engine = build_engine(_settings(test_database_url))
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


@pytest.fixture(scope="session", autouse=True)
def _migrated_schema(test_database_url: str, _require_test_db: None) -> Iterator[None]:
    """Apply migration 0001 to budget_test for the session; reverse it at the end.

    Runs alembic in a subprocess with DATABASE_URL pointed at the test DB (env vars
    take precedence over apps/api/.env), so the schema under test IS the migration
    output.
    """
    env = {
        **os.environ,
        "DATABASE_URL": test_database_url,
        "JWT_SECRET": TEST_JWT_SECRET,
    }
    subprocess.run(
        ["uv", "run", "alembic", "upgrade", "head"],
        cwd=_API_DIR,
        env=env,
        check=True,
    )
    yield
    subprocess.run(
        ["uv", "run", "alembic", "downgrade", "base"],
        cwd=_API_DIR,
        env=env,
        check=True,
    )


@pytest.fixture(autouse=True)
async def _clean_tables(test_database_url: str) -> None:
    """Delete all users before each test for isolation, preserving seeded rows.

    Row-level ``DELETE FROM users`` fires the per-row ``ondelete=CASCADE`` on every
    user-referencing FK, so profiles, user-owned categories, transactions, and
    refresh_tokens are cleared. The 18 system categories (``user_id IS NULL``) do
    not participate in the user FK and survive — table-level ``TRUNCATE … CASCADE``
    would have wiped them via the FK graph (architecture §9 landmine).

    ``exchange_rates`` is cleared separately and load-bearingly: it has NO user FK,
    so the per-row user cascade does not touch it and one test's seeded rates would
    leak into another test's no-rate assertions. ``goals`` / ``goal_contributions``
    do cascade through the user FK chain and need nothing.
    """
    engine = build_engine(_settings(test_database_url))
    try:
        async with engine.begin() as conn:
            await conn.execute(text("DELETE FROM users"))
            await conn.execute(text("DELETE FROM exchange_rates"))
    finally:
        await engine.dispose()


@pytest.fixture
async def make_client(
    test_database_url: str,
) -> AsyncIterator[Callable[..., Awaitable[AsyncClient]]]:
    """Factory building a lifespan-managed client with per-test settings overrides.

    Rate limiting is disabled by default so ordinary tests are decoupled from limit
    tuning; the 429 tests pass ``rate_limit_enabled=True`` plus a tight limit.

    All three scheduler gates are disabled unconditionally: the multi-app pattern must
    never spawn background jobs or make a provider call at boot (architecture D3 /
    D5). pytest drives ``fetch_daily_rates`` / ``catch_up_needed`` /
    ``materialize_due`` / ``send_daily_reminders`` directly instead; the wiring
    itself is asserted (without behaviour) by ``test_scheduler_wiring.py`` and
    verified live at /test.
    """
    async with AsyncExitStack() as stack:

        async def _make(**overrides: object) -> AsyncClient:
            overrides.setdefault("rate_limit_enabled", False)
            overrides.setdefault("fx_scheduler_enabled", False)
            overrides.setdefault("recurring_scheduler_enabled", False)
            overrides.setdefault("push_scheduler_enabled", False)
            app = create_app(_settings(test_database_url, **overrides))
            await stack.enter_async_context(LifespanManager(app))
            transport = ASGITransport(app=app)
            return await stack.enter_async_context(
                AsyncClient(transport=transport, base_url="http://test")
            )

        yield _make


@pytest.fixture
async def make_push_client(
    test_database_url: str,
) -> AsyncIterator[Callable[..., Awaitable[AsyncClient]]]:
    """Factory: a client whose app may carry a fake push sender (web push §3).

    Not foldable into ``make_client``: the sender must be swapped onto
    ``app.state`` BEFORE the first request. ``sender=None`` keeps the REAL
    ``PushSender`` built from the settings — only for tests that never reach a
    send (the config/503 honesty checks). The VAPID trio is set by default so the
    real sender reads as enabled; a test overrides the three to "" for the keyless
    server. Every gate default of ``make_client`` applies.
    """
    async with AsyncExitStack() as stack:

        async def _make(
            sender: PushSender | None = None, **overrides: object
        ) -> AsyncClient:
            overrides.setdefault("rate_limit_enabled", False)
            overrides.setdefault("fx_scheduler_enabled", False)
            overrides.setdefault("recurring_scheduler_enabled", False)
            overrides.setdefault("push_scheduler_enabled", False)
            overrides.setdefault("vapid_public_key", "test-vapid-public-key")
            overrides.setdefault("vapid_private_key", "test-vapid-private-key")
            overrides.setdefault("vapid_subject", "mailto:qa-push@budgetqa.dev")
            app = create_app(_settings(test_database_url, **overrides))
            if sender is not None:
                app.state.push_sender = sender
            await stack.enter_async_context(LifespanManager(app))
            transport = ASGITransport(app=app)
            return await stack.enter_async_context(
                AsyncClient(transport=transport, base_url="http://test")
            )

        yield _make


@pytest.fixture
async def make_llm_client(
    test_database_url: str,
) -> AsyncIterator[Callable[..., Awaitable[AsyncClient]]]:
    """Factory: a client whose app may carry a given LLM provider (ai-layer §Seams).

    Not foldable into ``make_client`` for the ``make_push_client`` reason: the
    provider must be on ``app.state`` BEFORE the first request. ``llm=None`` keeps
    whatever ``provider_from_settings`` built from the settings — which, with the
    shared ``anthropic_api_key`` empty by default, is ``None`` itself, i.e. the
    not-configured arm. Pass ``FakeProvider("fake")`` for the categorizing arms;
    every gate default of ``make_client`` applies.
    """
    async with AsyncExitStack() as stack:

        async def _make(
            llm: LLMProvider | None = None, **overrides: object
        ) -> AsyncClient:
            overrides.setdefault("rate_limit_enabled", False)
            overrides.setdefault("fx_scheduler_enabled", False)
            overrides.setdefault("recurring_scheduler_enabled", False)
            overrides.setdefault("push_scheduler_enabled", False)
            app = create_app(_settings(test_database_url, **overrides))
            if llm is not None:
                app.state.llm = llm
            await stack.enter_async_context(LifespanManager(app))
            transport = ASGITransport(app=app)
            return await stack.enter_async_context(
                AsyncClient(transport=transport, base_url="http://test")
            )

        yield _make


@pytest.fixture
async def client(
    make_client: Callable[..., Awaitable[AsyncClient]],
) -> AsyncClient:
    return await make_client()


@pytest.fixture(scope="session")
def statement_csv_bytes() -> bytes:
    """The synthetic Priorbank export, cp1251 bytes, exactly as uploaded.

    A SYNTHETIC file, never the user's real statement: it carries no personal data
    and is built to hold every structural trap of the format at once — two
    operation blocks with their own headers and totals, a "Заблокированные суммы"
    tail on a different grid, a foreign-currency row, a zero turnover, two
    byte-identical payments, a ``00:00:00`` clock, and both an NBSP and an ordinary
    space as the thousands separator.

    Session-scoped and shared: the parser tests and the API tests must read the
    SAME bytes, or one of them would be proving something about a file the other
    does not have.
    """
    return (
        Path(__file__).parent / "fixtures" / "statement_priorbank_synthetic.csv"
    ).read_bytes()


@pytest.fixture(scope="session")
def credo_xlsx_bytes() -> bytes:
    """The synthetic Credo workbook, xlsx bytes, exactly as uploaded.

    SYNTHETIC, never the user's real statement — and built in code (see
    ``helpers.build_credo_xlsx``) rather than checked in, because a zip archive is
    a fixture nobody can review. It holds every trap of the format at once: a bare
    1900 serial date next to an already-typed one, text money with a thousands
    comma, both turnover columns in use, a foreign pair in an unsupported currency
    (CHF), a pair in the ACCOUNT's own currency (which must be dropped), two
    byte-identical withdrawals, a fee line with no merchant, an unknown Georgian
    operation, and a zero turnover.

    Session-scoped and shared for the same reason the Priorbank one is: the parser
    tests and the apply test must read the SAME bytes.
    """
    return build_credo_xlsx()


@pytest.fixture
def pat_factory() -> Callable[..., Awaitable[dict[str, Any]]]:
    """Issue a personal access token through the real ``POST /tokens`` route.

    Returns the whole ``TokenCreated`` body, so a test can use both the one-time
    plaintext (``["token"]``) and the id the rate-limit key / audit rows carry
    (``["id"]``). Deliberately NOT a direct row insert: every PAT a test
    authenticates with was minted by the same code path a user's would be, so a
    hashing change cannot pass the suite while breaking production.
    """

    async def _make(
        client: AsyncClient,
        headers: dict[str, str],
        scope: str = "full",
        name: str = "test token",
    ) -> dict[str, Any]:
        resp = await client.post(
            "/tokens", json={"name": name, "scope": scope}, headers=headers
        )
        assert resp.status_code == 201, resp.text
        body: dict[str, Any] = resp.json()
        return body

    return _make


@pytest.fixture
async def db_session(test_database_url: str) -> AsyncIterator[AsyncSession]:
    """Direct AsyncSession for row setup (inactive user, expired token)."""
    engine = build_engine(_settings(test_database_url))
    sessionmaker = build_sessionmaker(engine)
    try:
        async with sessionmaker() as session:
            yield session
    finally:
        await engine.dispose()
