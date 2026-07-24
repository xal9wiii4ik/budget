# Implementation Plan: api-skeleton (roadmap 0.2)

Follows `architecture.md` and the three senior-lead amendments (A1 `.gitkeep`, A2
root README "Run the API locally" section + root files owned by backend-engineer,
A3 host port **5433**). No architectural deviations — see §Disagreements (empty).

## Approach

Turn the empty `apps/api` package into a runnable FastAPI service exactly as the
architecture specifies: app-factory + lifespan-scoped async engine on `app.state`,
single-field `Settings`, async SQLAlchemy session dependency, `Base` with the
naming convention, async-template Alembic wired to `Settings`, one real `GET /health`
endpoint hitting the real DB via the production dependency path, pyright + expanded
ruff, a multi-stage uv Dockerfile, and a root DB-only `docker-compose.yml`. Tests are
two real health tests against `budget_test` (no mocks); the placeholder is deleted.

Version pins follow the 0.1 precedent (`pytest>=8`, `ruff>=0.6`): **lower-bound `>=`
floors** on the current stable major/minor, with exact resolutions frozen in
`uv.lock`. I run `uv add` at implementation time so the floors match whatever stable
resolves then; the floors below are indicative, not final.

## Ordered implementation steps

### 1. Dependencies — `apps/api/pyproject.toml`

Add via `uv add` (main) / `uv add --dev` (dev) so `uv.lock` updates:

- **Main** (`[project].dependencies`): `fastapi`, `uvicorn[standard]`,
  `sqlalchemy[asyncio]`, `asyncpg`, `alembic`, `pydantic-settings`.
  (Alembic is **main**, not dev — the image runs `alembic upgrade head` at 1.7.)
- **Dev** (`[dependency-groups].dev`): add `pyright`, `pytest-asyncio`, `httpx`,
  `asgi-lifespan` to the existing `pytest>=8`, `ruff>=0.6`.

Indicative floors (confirm current stable at implementation): `fastapi>=0.115`,
`uvicorn>=0.34`, `sqlalchemy>=2.0.36`, `asyncpg>=0.30`, `alembic>=1.14`,
`pydantic-settings>=2.7`, `pyright>=1.1.390`, `pytest-asyncio>=0.25`, `httpx>=0.28`,
`asgi-lifespan>=2.1`.

### 2. Tool config — `apps/api/pyproject.toml`

- **Ruff** (§9): `[tool.ruff.lint] select = ["E","W","F","I","UP","B","C4","SIM","RUF","ASYNC"]`;
  add `[tool.ruff.lint.flake8-bugbear] extend-immutable-calls = ["fastapi.Depends","fastapi.Query","fastapi.Path","fastapi.Header"]`.
  No per-file-ignores. `target-version = "py312"` stays.
- **pyright** (§7): `[tool.pyright]` with `include = ["src","tests"]`,
  `exclude = ["alembic", "**/.venv", "**/__pycache__"]`, `venvPath = "."`,
  `venv = ".venv"`, `typeCheckingMode = "strict"`, and an `executionEnvironments`
  entry pinning `tests` to `"standard"`.
- **pytest-asyncio**: `[tool.pytest.ini_options] asyncio_mode = "auto"` and
  `asyncio_default_fixtures_loop_scope = "function"` (silences the loop-scope warning;
  keeps each app's lifespan engine on the test's own loop — see Risks).

### 3. `apps/api/src/budget_api/__init__.py`

Keep `__version__ = "0.1.0"`; drop the "subpackages land in 0.2" note (now false).
`__version__` becomes load-bearing (fed to `FastAPI(version=...)`).

### 4. `apps/api/src/budget_api/config.py` (new)

```python
class Settings(BaseSettings):
    database_url: str
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]  # values come from env/.env
```

One field, no prefix. `get_settings()` is the canonical accessor for `create_app`'s
default and `alembic/env.py`. Tests never touch the cache — they build `Settings(database_url=...)` explicitly.

### 5. `apps/api/src/budget_api/models/base.py` (new) + `models/__init__.py` (new)

`base.py`: `NAMING_CONVENTION` dict (§4) and
```python
class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)
```
`models/__init__.py`: re-export `Base` now; a `# models register here from 1.2` note.
Alembic imports this package so future models auto-register on the metadata.

### 6. `apps/api/src/budget_api/db.py` (new)

```python
def build_engine(settings: Settings) -> AsyncEngine:
    return create_async_engine(settings.database_url, connect_args={"timeout": 2})

def build_sessionmaker(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False)

async def get_session(request: Request) -> AsyncIterator[AsyncSession]:
    sessionmaker = request.app.state.sessionmaker
    async with sessionmaker() as session:
        yield session
```

`connect_args={"timeout": 2}` bounds asyncpg's connect (default 60s) so a down DB
fails fast; the endpoint's `asyncio.wait_for` is belt-and-suspenders (§8 below).

### 7. `apps/api/src/budget_api/app.py` (new)

```python
def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        engine = build_engine(settings)
        app.state.engine = engine
        app.state.sessionmaker = build_sessionmaker(engine)
        try:
            yield
        finally:
            await engine.dispose()

    app = FastAPI(title="Budget API", version=__version__, lifespan=lifespan)
    app.include_router(health.router)
    return app
```

### 8. `apps/api/src/budget_api/schemas/health.py` + `routers/health.py` (new) + `schemas/__init__.py`, `routers/__init__.py`

`schemas/health.py`:
```python
class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    database: Literal["ok", "unavailable"]
```
`routers/health.py` — the §6 contract, DB check via the production `get_session` dep:
```python
logger = logging.getLogger(__name__)
router = APIRouter()

@router.get("/health", response_model=HealthResponse)
async def health(
    response: Response,
    session: AsyncSession = Depends(get_session),
) -> HealthResponse:
    try:
        await asyncio.wait_for(session.execute(text("SELECT 1")), timeout=2.0)
    except (SQLAlchemyError, asyncio.TimeoutError, OSError) as exc:
        logger.warning("health DB check failed: %s", exc)
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return HealthResponse(status="degraded", database="unavailable")
    return HealthResponse(status="ok", database="ok")
```
Notes: 503 is set via `Response.status_code` (not `HTTPException`) so the body is the
typed `HealthResponse` in **both** cases per the §6 table. `SELECT 1` uses
`sqlalchemy.text`. Exception detail is logged, never returned. `session.execute`
triggers the lazy connect, so a down DB surfaces here, not in the dependency.

### 9. `apps/api/src/budget_api/domain/__init__.py` + `services/__init__.py` (new)

Docstring-only packages encoding the layer contract from architecture §1
(dependency direction). `domain/`: pure logic, no framework/internal imports.
`services/`: external integrations; may import `domain`, `models`, `db`, `config`.

### 10. Alembic — `apps/api/alembic.ini`, `apps/api/alembic/env.py`, `script.py.mako`, `versions/.gitkeep`

- Run `uv run alembic init -t async alembic` from `apps/api`.
- `alembic.ini`: **remove** `sqlalchemy.url` line entirely (URL comes from Settings).
- `env.py` rework:
  - `from budget_api.config import get_settings`, `from budget_api.models import Base`.
  - `target_metadata = Base.metadata`.
  - In both offline and online paths build the URL/engine from
    `get_settings().database_url` (online: `create_async_engine(url)` +
    `connection.run_sync(do_run_migrations)` inside `asyncio.run` — the async
    template's shape, just re-pointed at Settings).
  - Do **not** call `config.set_main_option` (avoids `%`-escaping).
- `versions/`: commit empty with **`.gitkeep`** (amendment A1). **No** initial
  revision (§5) — 1.2 writes revision 0001.

### 11. Root `docker-compose.yml` (new) + init script `docker/postgres/init/01-create-test-db.sql` (new)

At repo root (backend-engineer owns root files per 0.1, confirmed by A2). One service:

```yaml
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: budget
      POSTGRES_PASSWORD: budget
      POSTGRES_DB: budget
    ports:
      - "5433:5432"          # amendment A3
    volumes:
      - budget_pg_data:/var/lib/postgresql/data
      - ./docker/postgres/init:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U budget"]
      interval: 5s
      timeout: 3s
      retries: 5
volumes:
  budget_pg_data:
```

Init script: `CREATE DATABASE budget_test;` (runs once on first volume init; note in
README that recreating the test DB needs `docker compose down -v` if the volume
predates this script).

### 12. `apps/api/.env.example` (new)

```
DATABASE_URL=postgresql+asyncpg://budget:budget@localhost:5433/budget
```

Real `.env` is gitignored at root (verified: `.gitignore` lines 15-18 cover `.env`
and `.env.*` with `!.env.example`).

### 13. `apps/api/Dockerfile` + `apps/api/.dockerignore` (new) — build context `apps/api`

Multi-stage per §10:
- **Builder** `ghcr.io/astral-sh/uv:python3.12-bookworm-slim`; `UV_COMPILE_BYTECODE=1`,
  `UV_LINK_MODE=copy`; copy `pyproject.toml`+`uv.lock` → `uv sync --frozen --no-dev
  --no-install-project` → copy `src/` → `uv sync --frozen --no-dev`.
- **Runtime** `python:3.12-slim-bookworm`; non-root `app` uid 1000; copy `/app/.venv`;
  `PATH=/app/.venv/bin:$PATH`; copy `alembic.ini`+`alembic/`; `EXPOSE 8000`;
  `CMD ["uvicorn","budget_api.app:create_app","--factory","--host","0.0.0.0","--port","8000"]`.
- `.dockerignore`: `.venv/`, `__pycache__/`, `*.pyc`, `tests/`, `.env`, `.pytest_cache/`,
  `.ruff_cache/`, `.python-version` optional. (Excluding `tests/` is fine — image
  doesn't run tests.)

### 14. `apps/api/package.json`

- `"typecheck": "uv run pyright"`
- `"dev": "uv run uvicorn budget_api.app:create_app --factory --reload"`
- `lint`, `test` unchanged.

### 15. Root `turbo.json`

Extend `inputs` for `@budget/api#lint`, `#typecheck`, `#test` from
`["src/**","tests/**","pyproject.toml","uv.lock"]` to also include
`"alembic/**"` and `"alembic.ini"`. Do **not** add `.env.example`, `Dockerfile`,
`.dockerignore`, or a `docker:build` task (§11).

### 16. Root `README.md` (amendment A2)

Add a "Run the API locally" section: `docker compose up -d postgres` →
`cp apps/api/.env.example apps/api/.env` → `uv sync` (in `apps/api`) →
`pnpm --filter @budget/api dev` (or `pnpm turbo dev --filter=@budget/api`) →
`curl localhost:8000/health`; plus `uv run alembic upgrade head` (no-op today) and
`pnpm turbo test --filter=@budget/api`. Note port 5433 and the `down -v` caveat for
`budget_test`.

### 17. Tests — delete `tests/test_placeholder.py`; add `tests/conftest.py`, `tests/test_health.py`

See Test plan.

## Test plan

**Deleted:** `tests/test_placeholder.py` (scaffold-lifetime rule, binding). Its
`__version__` assertion is **not** replaced — vacuous; `__version__` is now exercised
transitively through `create_app`.

**No `make test`** exists in this repo; the real command is `uv run pytest` (invoked
by `pnpm turbo test --filter=@budget/api`). The skill's `make test` maps to that.

### Test DB URL provisioning — decision

`conftest.py` reads env var **`TEST_DATABASE_URL`**, defaulting to the hardcoded
`postgresql+asyncpg://budget:budget@localhost:5433/budget_test`. Justification: the
default matches the compose init script so local dev is zero-config; CI-someday
overrides via one env var (architecture §8's "conftest reads it"). This is a
*separate* var from app `DATABASE_URL` so running the suite never risks pointing at a
real/dev DB.

### conftest fixtures

- `test_database_url` (session) — `os.environ.get("TEST_DATABASE_URL", <default budget_test url>)`.
- `_require_test_db` (session, autouse) — fail-fast: opens one short connection to
  `test_database_url` (own engine, disposed immediately). On `OSError`/SQLAlchemy
  connection error → `pytest.exit("test Postgres unreachable — run: docker compose up -d postgres", returncode=1)`.
  Guards only the real `budget_test` DB; the DB-down test uses its own unreachable URL.
- `client` (function) — builds `create_app(Settings(database_url=test_database_url))`,
  wraps it in `asgi_lifespan.LifespanManager` (so the lifespan actually creates the
  engine), yields `httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test")`.
  Function-scoped to keep the lifespan engine on the test's own event loop.

### Tests (`tests/test_health.py`, class-based)

`class TestHealth`:

1. `test_health_ok` — `GET /health` via `client` against real `budget_test`.
   Asserts `200` and body exactly `{"status":"ok","database":"ok"}`.
   **Proves:** the whole production path — dependency → `app.state.sessionmaker` →
   pool → asyncpg → `SELECT 1` — is wired correctly end to end. This is the test that
   justifies the session machinery; mocking would prove nothing.

2. `test_health_db_unavailable` — builds a second app with a deliberately unreachable
   `database_url` (`postgresql+asyncpg://budget:budget@localhost:5599/budget`, nothing
   listening), drives `GET /health` through its own lifespan-managed client, times the
   call. Asserts `503`, body exactly `{"status":"degraded","database":"unavailable"}`,
   and `elapsed < 5s` (promptness — proves the connect cap works, not asyncpg's 60s
   default). **Proves:** the real failure branch and the 503 contract without
   monkeypatching internals.

No other pytest tests. Deliberately excluded as vacuous (user global policy + skill):
`create_app`-returns-FastAPI, settings parsing, `HealthResponse` schema validation,
package-import smoke.

### pytest vs curl split (for qa-checklist.md, coordinate with qa-engineer)

- **pytest** (above): healthy `/health` contract; DB-down `/health` 503 contract +
  promptness.
- **curl / live-server (QA)**: dev server boots via `pnpm --filter @budget/api dev`
  and serves both cases; `uv run alembic upgrade head` no-op + `alembic check` clean +
  throwaway `--autogenerate` comes out empty (transient migration wiring proof);
  `docker build apps/api` succeeds, container runs **non-root**, `/health` returns
  **503-degraded** standalone (no DB) — still proves the app boots.

## Acceptance criteria (exact commands, all must pass)

1. `pnpm turbo lint typecheck test --filter=@budget/api` — ruff clean, pyright strict
   clean on `src`, both health tests pass. (Precondition: `docker compose up -d postgres`.)
2. Migration wiring — from `apps/api`: `uv run alembic upgrade head` (clean no-op) and
   `uv run alembic check` exits 0 (no pending changes against empty metadata). Bonus:
   `uv run alembic revision --autogenerate -m tmp` produces an **empty** upgrade/downgrade,
   then delete the file.
3. Dev boot: `pnpm --filter @budget/api dev`, then
   `curl -s localhost:8000/health` → `200 {"status":"ok","database":"ok"}` with compose up;
   stop postgres → `curl` returns `503 {"status":"degraded","database":"unavailable"}`
   in low single-digit seconds.
4. Docker: `docker build apps/api -t budget-api`; `docker run --rm -p 8000:8000 budget-api`;
   `curl -s localhost:8000/health` → `503` degraded (no DB reachable — proves boot);
   container process runs as non-root (`whoami` in an exec → `app`).

## Risks / gotchas

- **pytest-asyncio loop scope vs lifespan engine.** The async engine is created inside
  each app's lifespan; a session-scoped `client` would bind it to a loop different from
  the per-test loop → "attached to a different loop". Mitigation: `client` is
  **function-scoped**; `asyncio_default_fixtures_loop_scope = "function"`.
- **`alembic check` with zero revisions.** Empty metadata + empty `budget_test` →
  no diff → exit 0. If `budget_test` accidentally has leftover tables (e.g. from a
  future branch), `check` would flag a diff — acceptance step 2 assumes a clean test DB.
- **pyright strict on SQLAlchemy.** At 0.2 there are no models (only `Base`), so strict
  findings are minimal; `Settings()` needs a `# type: ignore[call-arg]` (fields from
  env). `get_session`'s `request.app.state` is `Any` — acceptable. Real strict pressure
  arrives at 1.2 with `Mapped[]` columns (native, works in pyright — no plugin).
- **`.env` discovery is CWD-relative.** `env_file=".env"` resolves from the process CWD.
  `dev`/`alembic` are documented to run from `apps/api`. Document this in README; tests
  never rely on `.env` (they pass explicit `Settings`).
- **Compose init script runs once.** `budget_test` is created only on first volume init.
  A pre-existing `budget_pg_data` volume won't get it → `down -v` documented.
- **`.gitignore` coverage.** Verified root `.gitignore` covers `.env`/`.env.*` (keeps
  `.env.example`), `.venv/`, `__pycache__/`, `.pytest_cache/`, `.ruff_cache/`. New
  artifacts: pyright needs none; the compose named volume is Docker-managed (not on
  disk in-repo). No `.gitignore` change required — confirm at implementation, add only
  if a new tracked-artifact appears.
- **DB-down test exercises connection-refused, not timeout.** Port 5599 refuses
  immediately (prompt 503), which is the realistic failure and keeps the test fast/
  non-flaky. The `wait_for`/connect-timeout path (black-hole IP) is deliberately not
  unit-tested to avoid flakiness; the `< 5s` assertion still guards against the 60s
  default hang. Noted rather than adding a flaky timeout test.
- **`uvicorn --factory` target.** Dev script and Docker CMD both use
  `budget_api.app:create_app --factory` so dev and prod boot identically; a rename of
  `create_app` breaks both — kept in sync intentionally.

## Disagreements with architecture.md

None. All three senior-lead amendments are incorporated (A1 `.gitkeep` resolves the
doc's self-contradictory `versions/` comment; A2 root README + root-file ownership;
A3 port 5433 overrides the §8 "5533" typo).

## Open questions

None beyond the architect's two already-decided items (pyright vs mypy → pyright;
host port 5433). Nothing PM-facing remains.
