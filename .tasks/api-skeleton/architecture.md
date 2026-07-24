# Architecture Plan: api-skeleton (roadmap 0.2)

## Context

Task 0.1 left `apps/api` as an installable empty package wired into turbo. This task makes it a runnable FastAPI service: app factory, settings, async SQLAlchemy plumbing, Alembic, one real endpoint (`GET /health`), real `dev`/`typecheck` scripts, Dockerfile, and the deferred ruff/typechecker decisions. The structural stakes: the module layout and DB session lifecycle chosen here are what 1.1 (fastapi-users) and 1.2 (real tables + first migration) build directly on top of. Bias, as in 0.1: simplest thing that doesn't get ripped out at stage 1–4.

Out of scope (binding): no auth, no business tables, no CI, no prod compose.

## 1. Module layout

```
apps/api/
├── package.json                # scripts updated (see §11)
├── pyproject.toml              # new deps, ruff expansion, pyright config, pytest config
├── uv.lock
├── .python-version
├── .env.example                # DATABASE_URL only (see §3)
├── Dockerfile                  # see §10
├── .dockerignore               # see §10
├── alembic.ini                 # no sqlalchemy.url in it (see §5)
├── alembic/
│   ├── env.py                  # async template, url from Settings
│   ├── script.py.mako
│   └── versions/               # empty at 0.2 (see §5); .gitkeep NOT needed — alembic
│                               #   recreates it; keep dir via env.py? No: commit an
│                               #   empty versions/ with .gitkeep (git can't track empty dirs)
├── src/budget_api/
│   ├── __init__.py             # keeps __version__ (used by create_app for OpenAPI info)
│   ├── app.py                  # create_app(), lifespan
│   ├── config.py               # Settings (pydantic-settings), get_settings()
│   ├── db.py                   # build_engine(), build_sessionmaker(), get_session dependency
│   ├── routers/
│   │   ├── __init__.py
│   │   └── health.py           # GET /health
│   ├── schemas/
│   │   ├── __init__.py
│   │   └── health.py           # HealthResponse
│   ├── models/
│   │   ├── __init__.py         # re-exports all models (1.2+); alembic imports this
│   │   └── base.py             # Base(DeclarativeBase) + naming_convention (see §4)
│   ├── domain/
│   │   └── __init__.py         # docstring-only: layer contract (pure logic, no internal imports)
│   └── services/
│       └── __init__.py         # docstring-only: layer contract (external integrations)
└── tests/
    ├── conftest.py             # settings/app/client fixtures (see §8)
    └── test_health.py          # replaces test_placeholder.py (deleted)
```

On the "no files that prove nothing" rule vs the five mandated layers: `domain/` and `services/` have no code until 2.x/3.x, but they are created now as `__init__.py`-only packages whose docstrings state the layer's role and allowed imports. That docstring is the content — it fixes file placement and dependency rules once, so tasks 1.1–3.4 don't each re-decide structure. Alternative (create them when first used) rejected: the whole point of 0.2 is that the skeleton *is* the structure. `routers/`, `schemas/`, `models/` all carry real code from day one (health router, HealthResponse, Base).

Core plumbing is flat at package root (`app.py`, `config.py`, `db.py`) — three files don't justify a `core/` subpackage. If plumbing grows (unlikely before stage 2), moving to `core/` is a mechanical refactor.

### Dependency direction (binding for all future tasks)

```
app.py      → config, db, routers
routers/    → schemas, services, domain, models, db, config
services/   → domain, models, db, config
domain/     → nothing internal (pure functions; no SQLAlchemy, no FastAPI, no Pydantic models from schemas/)
schemas/    → nothing internal (Pydantic only; may later import shared enums from domain)
models/     → models.base only (+ SQLAlchemy)
db.py       → config
config.py   → nothing internal
alembic/env → config, models
```

Forbidden in all cases: importing `routers/` or `app.py` from anywhere except `app.py`/tests; `domain/` importing any framework; `models/` importing `schemas/` or vice versa. No repositories layer yet — the architecture doc doesn't mandate one, and with zero tables it would be premature abstraction; revisit at 1.3–1.4 if query code starts duplicating in routers.

## 2. App factory + lifespan

`create_app(settings: Settings | None = None) -> FastAPI`. If `settings` is None, falls back to `get_settings()`. The factory builds the FastAPI instance (`title="Budget API"`, `version=__version__`), registers routers, and attaches a lifespan.

**Engine/sessionmaker scope: created in lifespan, stored on `app.state`.** Lifespan startup: `app.state.engine = build_engine(settings)`, `app.state.sessionmaker = build_sessionmaker(engine)`. Shutdown: `await engine.dispose()`.

Why not module-global engine in `db.py`: import-time settings read makes tests order-dependent and overriding the DB awkward; a global engine created outside the running event loop is a classic source of "attached to a different loop" errors under pytest-asyncio. Why not created-in-factory (outside lifespan): engine disposal has no natural home and the engine would exist even for apps that are constructed but never served. Lifespan + `app.state` gives: each test app gets its own engine against its own URL, cleanly disposed; and in 1.1 fastapi-users' `get_user_db` dependency chains off the same `get_session` with zero changes.

## 3. Settings

`config.py`: `class Settings(BaseSettings)` with **exactly one field now**: `database_url: str`. No env name, no debug flag, no Claude/S3 keys — nothing in this task reads them. Fields get added when a task needs them.

- **No env prefix.** The deploy targets in the architecture doc (Railway/Fly/Render) inject `DATABASE_URL` by convention; unprefixed means 1.7 needs zero glue. Collision risk on a dev machine is negligible and `.env` wins locally.
- `model_config = SettingsConfigDict(env_file=".env")` — `.env` for local dev (already gitignored at repo root), real env vars override.
- `.env.example` committed with `DATABASE_URL=postgresql+asyncpg://budget:budget@localhost:5433/budget` (see §8 for the port).
- **Access pattern:** `get_settings()` with `@lru_cache` is the canonical accessor (used by `create_app` default and `alembic/env.py`). Tests never touch the cache — they construct `Settings(database_url=...)` explicitly and pass it to `create_app`. Settings do not need to be a FastAPI dependency yet; nothing but the factory and Alembic consumes them.

## 4. DB session dependency

`db.py`:

- `build_engine(settings)` → `create_async_engine(settings.database_url)` (driver: **asyncpg** — SQLAlchemy's first-class async driver; URL scheme `postgresql+asyncpg://`).
- `build_sessionmaker(engine)` → `async_sessionmaker(engine, expire_on_commit=False)`.
- `get_session(request: Request)` — async generator: `async with request.app.state.sessionmaker() as session: yield session`.

**expire_on_commit=False**: mandatory-in-practice for async SQLAlchemy — attribute expiry after commit triggers implicit lazy IO, which raises in async contexts. Decided.

**Commit policy at this stage:** no auto-commit in the dependency, no commit-on-success middleware. Endpoints/services commit explicitly; the `async with` context rolls back uncommitted work on error and closes the session. With only a read-only health endpoint this is trivially correct; revisit only if 1.3–1.4 show real commit boilerplate.

**Naming convention: set NOW.** `models/base.py`:

```python
NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(referent_table)s_%(column_0_name)s",
    "pk": "pk_%(table_name)s",
}

class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)
```

Reasoning verified: without a convention, Postgres auto-names constraints (`transactions_user_id_fkey` etc.); adding the convention after 1.2's tables exist makes autogenerate see every constraint as renamed, producing churn migrations — or worse, future drop-constraint migrations have to guess server-generated names. Setting it before any table exists costs zero and is the only churn-free moment. Correct call.

## 5. Alembic async wiring

- Location: `apps/api/alembic.ini` + `apps/api/alembic/` (all Alembic commands run from `apps/api`, i.e. `uv run alembic ...`).
- Initialize from the **async template** (`alembic init -t async alembic`): `env.py` builds an `AsyncEngine`, runs migrations via `connection.run_sync(do_run_migrations)` inside `asyncio.run(...)`. This is the upstream-blessed pattern; no hand-rolled loop management.
- **URL single source of truth = Settings.** `alembic.ini` contains no `sqlalchemy.url`. `env.py` calls `get_settings()` and constructs the engine from `settings.database_url` directly (not via `set_main_option`, which requires `%`-escaping). One URL definition works identically for local dev, the Docker container, and CI-someday.
- `target_metadata = Base.metadata`, with `env.py` importing `budget_api.models` (the package `__init__`, which re-exports models) so every future model registers on the metadata without editing `env.py` again. That re-export convention starts now (empty list) and becomes load-bearing at 1.2.

**Verdict on the empty initial revision: do NOT create one.** With zero revisions, `alembic upgrade head` is a clean no-op and `alembic check` passes against an empty DB — wiring is verifiable (QA runs `alembic check` and/or a throwaway `revision --autogenerate` that must come out empty) without polluting history. An empty "initial" revision would live in the migration chain forever and proves nothing that `alembic check` doesn't. 1.2 writes revision 0001 with the real tables. Trade-off acknowledged: no committed artifact permanently proves autogenerate ran end-to-end — accepted, because 1.2 provides that proof weeks, not months, later, and QA proves it now transiently.

Alembic goes in **main dependencies, not dev** — the Docker image must be able to run `alembic upgrade head` at deploy time (1.7).

## 6. GET /health contract

**One endpoint.** Liveness/readiness split is a k8s-ism; the deploy targets take a single health-check URL and this is a single-process container. Splitting is speculative.

- Route: `GET /health` (no auth, registered from `routers/health.py`).
- DB check: **through the same `get_session` dependency** as future endpoints, executing `text("SELECT 1")`. Rationale: at 0.2, `/health` is the only consumer of the session machinery — proving the *production path* (dependency → app.state sessionmaker → pool → asyncpg) is most of this task's value. A raw-connection shortcut would leave the dependency untested by anything. Session creation itself doesn't connect (lazy), so the failure surfaces at `execute` inside the endpoint's try/except — the dependency never raises.
- The ping is capped (e.g. `asyncio.wait_for(..., ~2s)` — exact mechanism is the engineer's call) so a down/unreachable DB returns promptly instead of hanging toward asyncpg's 60s default connect timeout. QA-testable behavior: the DB-down response arrives in low single-digit seconds, not a minute.
- Exception details are logged server-side, never returned (API faces the internet).

Response schema (`schemas/health.py`), identical shape in both cases:

| Case | Status | Body |
|---|---|---|
| Healthy | `200` | `{"status": "ok", "database": "ok"}` |
| DB unreachable/erroring/timeout | `503` | `{"status": "degraded", "database": "unavailable"}` |

`HealthResponse`: `status: Literal["ok", "degraded"]`, `database: Literal["ok", "unavailable"]`. 503 (not 200-with-flag) because platform health checkers key off status codes. This table is the QA contract.

## 7. Typechecker: pyright (decided)

**pyright**, config in `pyproject.toml` `[tool.pyright]`, installed via the PyPI `pyright` wrapper in the uv dev group, script `uv run pyright`.

Justification:

- **Editor parity is the decisive factor for a solo dev.** The editor almost certainly runs Pylance/pyright; making CI-of-record the same engine eliminates the "editor green, typecheck red" (and reverse) split that two engines guarantee.
- **SQLAlchemy 2.0**: `Mapped[]`/`mapped_column` typing is PEP-561 native and works equally in both checkers (the old mypy plugin is dead in 2.0) — no mypy edge here.
- **Pydantic**: works in pyright natively via `dataclass_transform` (constructor/field checking included). mypy's pydantic plugin adds only marginal extras; not worth the engine split.
- **Installability**: the PyPI wrapper is a normal uv dev dep; it needs a Node runtime, which this pnpm monorepo guarantees is present. Acceptable moving part.
- Faster than mypy and stricter inference, which matters as models/ grows.

Strictness: `typeCheckingMode = "strict"` for `src/`, relaxed to `"standard"` for `tests/` (via `executionEnvironments`). Strict-from-day-one is nearly free on a codebase this size and only gets more expensive to adopt later. `include = ["src", "tests"]`; `alembic/` is excluded from pyright (its config-global idioms fight strict mode for zero payoff) but **is** covered by ruff. Venv discovery: `venvPath = "."`, `venv = ".venv"`.

## 8. Local Postgres strategy

Prod mandates Postgres; SQLite for tests is rejected outright (parity now, and 1.2+ needs real PG behavior).

**Dev: docker compose service.** New `docker-compose.yml` at **repo root** (it's shared dev infra; MinIO joins it in 2.1): one service, `postgres:17-alpine`, named volume, env `POSTGRES_USER/PASSWORD/DB=budget`, plus an init script (`/docker-entrypoint-initdb.d`) that creates a second database `budget_test`. **Host port 5533 vs 5432: bind 5433.** Homebrew postgres binaries exist on this machine; if a brew service ever occupies 5432 the collision is a confusing time sink, and 5433 costs nothing since the URL lives in one place (`.env.example`). Workflow: `docker compose up -d postgres` once; that's the documented precondition for `dev` and `test`.

**Test: same compose Postgres, separate `budget_test` database — not testcontainers.** Reasoning: testcontainers adds per-session container startup (seconds) to every `turbo test`, plus a heavier dependency, to solve an isolation problem we don't have at single-developer scale. The shared-instance/separate-database model keeps `turbo test` fast and is CI-portable (CI-someday runs a postgres service container and exports the same `DATABASE_URL`-style env var; conftest reads it). Cost: tests fail if compose isn't up — mitigated by a fail-fast conftest check with a clear "run docker compose up -d postgres" message. 1.2+ gets real PG features in tests for free.

**Health tests use the real DB, no mocks:**
- Healthy path: app fixture pointed at `budget_test` via explicit `Settings`, real request through httpx `ASGITransport` (+ `asgi-lifespan` so the lifespan actually runs), asserts the exact 200 contract. This is the test that proves engine/sessionmaker/dependency wiring — mocking it would prove nothing.
- DB-down path: second app instance constructed with a deliberately unreachable `database_url` (e.g. a closed localhost port); asserts the exact 503 contract and that it returns promptly. Real failure branch, no monkeypatching internals, fast.

Test deps (dev group): `pytest-asyncio`, `httpx`, `asgi-lifespan`.

**Scaffold-lifetime rule honored:** `tests/test_placeholder.py` is deleted. `__version__` survives — but only because it becomes *used* (fed into `FastAPI(version=...)`, hence visible in OpenAPI); the import-and-check-version test dies with the placeholder and is not replaced (the health test imports the package transitively). No tests for `create_app` returning a FastAPI instance, settings parsing, or ruff-checkable trivia — vacuous.

## 9. Ruff expansion

`select = ["E", "W", "F", "I", "UP", "B", "C4", "SIM", "RUF", "ASYNC"]`

- `W` — completes the pycodestyle pair; free.
- `UP` (pyupgrade) — keeps a py312-targeted codebase on modern syntax (`X | None`, etc.); autofixable, zero drag.
- `B` (bugbear) — real bug catches (mutable defaults, late-binding loops). One FastAPI interaction: instead of ignoring B008 wholesale, set `lint.flake8-bugbear.extend-immutable-calls = ["fastapi.Depends", "fastapi.Query", "fastapi.Path", "fastapi.Header"]` so B008 stays live for genuine bugs.
- `C4` (comprehensions), `SIM` (simplify) — cheap readability autofixes, no ideology.
- `RUF` — ruff-native checks incl. unused-`noqa` detection, which keeps suppressions honest.
- `ASYNC` — flake8-async: blocking calls inside async defs. Directly relevant to a fully-async FastAPI service; this is the highest-value addition for this codebase.

Deliberately excluded (pragmatism, solo dev): `N`, `D`, `ANN` (pyright owns typing), `S` (bandit — noise until there's attack surface worth it; revisit at 1.1 auth), `PL` (opinionated). Per-file-ignores: none needed yet — the usual tests ignores target rules (`S101`, `ANN`) we don't select. Add them when a selected rule actually fires wrongly in tests, not preemptively.

## 10. Dockerfile

**Build context: `apps/api`** (i.e. `docker build apps/api`), not repo root. The API is Python-self-contained — it consumes nothing from `packages/*` (contract flow is the reverse: 0.3 generates the TS client *from* the API). Repo-root context would drag the pnpm world into every image build for zero benefit. If that ever changes (it shouldn't), the context moves then.

Multi-stage, uv-based:

- **Builder**: `ghcr.io/astral-sh/uv:python3.12-bookworm-slim`; `UV_COMPILE_BYTECODE=1`, `UV_LINK_MODE=copy`; copy `pyproject.toml` + `uv.lock` → `uv sync --frozen --no-dev --no-install-project` (cached deps layer) → copy `src/` → `uv sync --frozen --no-dev`.
- **Runtime**: `python:3.12-slim-bookworm`; non-root user (`app`, uid 1000); copy the venv from builder; `PATH=/app/.venv/bin:$PATH`; copy `alembic.ini` + `alembic/` into the image so 1.7 can run `alembic upgrade head` from the same artifact (alembic is a main dep per §5); `EXPOSE 8000`; `CMD ["uvicorn", "budget_api.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]`.

**`.dockerignore` in `apps/api`: yes, needed even with the narrow context** — must exclude `.venv/` (host-platform binaries, huge), `__pycache__`, `tests/`, `.env`, caches. Without it the host venv leaks into the build context.

Explicitly OUT of scope: prod/dev compose for the API itself (compose is DB-only this task), CI image build/push, `HEALTHCHECK` instruction (deploy platforms probe HTTP), migrations-on-startup entrypoint (a 1.7 deploy decision). QA verifies: image builds, runs as non-root, serves `/health` (503-degraded without a DB is the expected standalone result — that still proves the app boots).

## 11. Turbo / package.json scripts

`apps/api/package.json`:

- `"dev": "uv run uvicorn budget_api.app:create_app --factory --reload"` — same app target as the Dockerfile CMD, so dev and prod boot identically. Turbo `dev` stays global `cache: false, persistent: true` — no per-package change needed.
- `"typecheck": "uv run pyright"`
- `lint`/`test` commands unchanged.

`turbo.json`: extend `@budget/api#lint`, `#typecheck`, `#test` inputs from `["src/**", "tests/**", "pyproject.toml", "uv.lock"]` to also include `"alembic/**", "alembic.ini"` — ruff lints `alembic/env.py`, and migration content will legitimately invalidate test caches from 1.2 on; uniform over-inclusion beats a stale green (turbo inputs only cost an occasional extra run). **Not** added: `.env.example` (affects no task output), `Dockerfile`/`.dockerignore` (no turbo task consumes them; a `docker:build` turbo task is deliberately not created — building images is not part of the lint/test loop).

pyproject additions — main deps: `fastapi`, `uvicorn[standard]`, `sqlalchemy[asyncio]`, `asyncpg`, `alembic`, `pydantic-settings`; dev group adds: `pyright`, `pytest-asyncio`, `httpx`, `asgi-lifespan`. Exact version pins: engineer picks current stable at implementation time (0.1 precedent).

## Trade-offs considered

- **Lifespan-scoped engine on app.state vs module-global**: testability and loop-safety beat the minor convenience of a global; fastapi-users (1.1) is indifferent.
- **pyright vs mypy**: editor parity + speed beat mypy's marginal pydantic-plugin extras; SQLAlchemy 2.0 is a tie.
- **Compose-shared test DB vs testcontainers**: fast `turbo test` and one less dependency beat hermeticity we don't need solo; CI-portable either way.
- **No empty Alembic revision**: clean history + `alembic check` verification beat a permanent no-op migration.
- **Naming convention now vs at 1.2**: zero cost now vs guaranteed autogenerate churn later.
- **`apps/api` build context vs repo root**: self-contained Python app; monorepo context adds only bloat.
- **Empty `domain/`/`services/` packages**: structure-as-contract (docstrings encode import rules) beats deferring placement decisions to five future tasks.

## What this does NOT decide

- Exact dependency versions; exact timeout mechanism for the health DB ping; logging setup details — backend-engineer at implementation time.
- fastapi-users integration shape, JWT config — 1.1.
- Any table, model, or first migration content — 1.2.
- OpenAPI client generation — 0.3 (note: `create_app` existing makes `python -c` schema export trivial then).
- Migrations-on-deploy strategy, CORS config, prod compose — 1.7.
- Repositories layer — introduced only if 1.3–1.4 justify it.

## Open questions for PM

None blocking. Two decisions the PM may want to veto (both decided below my line if unchallenged):

1. **Typechecker: pyright vs mypy** (roadmap explicitly framed this as the deferred choice). Recommendation: **pyright** — editor parity for a solo dev, equal SQLAlchemy 2.0 support, faster; mypy's only edge (pydantic plugin extras) is marginal.
2. **Compose Postgres on host port 5433 vs conventional 5432.** Recommendation: **5433** — homebrew postgres exists on this machine and a silent 5432 collision is a confusing failure; the port appears in exactly one committed place (`.env.example`).

## Decided by architect

- Module tree as in §1; five layers present from day one (`domain/`, `services/` as docstring-contract packages); flat `app.py`/`config.py`/`db.py`; no repositories layer yet.
- Engine + sessionmaker created in lifespan, stored on `app.state`; `create_app(settings=None)` with `get_settings()` fallback.
- Settings: single field `database_url`, **no env prefix**, `.env` + committed `.env.example`, `@lru_cache get_settings()`, tests pass explicit `Settings`.
- `async_sessionmaker(expire_on_commit=False)`; explicit commits, no auto-commit; **naming_convention set now** on `Base.metadata`.
- Alembic: async template, lives in `apps/api`, URL sourced solely from Settings (none in ini), `target_metadata = Base.metadata` via `budget_api.models` re-exports, **no empty initial revision**, alembic in main deps.
- `/health`: one endpoint, via `get_session` + `SELECT 1`, capped ping, `200 {"status":"ok","database":"ok"}` / `503 {"status":"degraded","database":"unavailable"}`.
- pyright strict on `src/`, standard on `tests/`, alembic excluded from pyright but ruff-covered.
- Dev DB: root `docker-compose.yml`, `postgres:17-alpine`, host port 5433, init script creates `budget_test`; tests hit real Postgres (`budget_test`), DB-down path via unreachable-URL app instance, no mocks.
- Ruff: `E W F I UP B C4 SIM RUF ASYNC`, bugbear `extend-immutable-calls` for FastAPI, no per-file-ignores yet.
- Dockerfile: multi-stage uv, context `apps/api`, non-root, alembic files in image, uvicorn `--factory` CMD; `.dockerignore` required.
- Scripts: `dev` = uvicorn `--factory --reload`; `typecheck` = `uv run pyright`; turbo inputs gain `alembic/**`, `alembic.ini`; `test_placeholder.py` deleted; `__version__` kept only because it feeds `FastAPI(version=...)`; its dedicated test dies unreplaced.
