# Grooming Review (Phase 4) — api-skeleton

Senior-lead critical review of architecture.md, plan.md (backend, 17 steps),
qa-checklist.md (20 checks). Verdict: **accepted with the amendments below.**
No artifact goes back for rewrite; amendments are binding on the implementers.

## 1. Conflicts

None. plan.md follows architecture.md with zero deviations (its Disagreements
section is genuinely empty, verified by cross-reading, not just by its claim), and
qa-checklist.md tests the exact §6 contract. The one architecture-doc defect
(self-contradictory `alembic/versions/` comment) was resolved by amendment A1
before the plan was written; the plan implements the resolution.

## 2. Cross-check results (plan ↔ QA)

Every QA check is satisfiable by the plan — verified point-by-point, including the
two the PM called out:

- **TC-B2 ping cap < 5s**: plan delivers it twice — `connect_args={"timeout": 2}`
  on the engine (bounds asyncpg's 60s connect default) AND `asyncio.wait_for(…, 2.0)`
  in the endpoint. The pytest DB-down case (closed port 5599) is connection-refused,
  i.e. near-instant; the <5s bound holds with margin.
- **TC-E2 non-root uid 1000**: plan step 13 creates user `app`, uid 1000 — exact match
  to QA's `id`/`whoami` assertion.
- Exact-JSON assertions (TC-A3/B1/B2/E3/E4) match the typed `HealthResponse`
  (`Literal` fields, `response_model=`) — no extra keys possible.
- TC-B5's `.info.version == __version__` is satisfied by `FastAPI(version=__version__)`
  (plan step 7) — this is also the sole justification for keeping `__version__`.
- Sections C (alembic no-op / check / empty-autogenerate), D (real scripts), E
  (Docker), F (hygiene), G (fail-fast) — all map to plan steps 10, 14–15, 13, 12/16,
  and the conftest `_require_test_db` fixture respectively.

Reverse direction (every plan step covered): steps 1–8, 10–15, 17 are covered by
pytest or QA checks. Three items are **review-gated, not QA-gated** (acknowledged,
correct — nothing runtime-testable about them): step 9 (`domain/`/`services/`
docstring-contract packages), step 15's exact turbo `inputs` list, and the naming
convention on `Base.metadata` (untestable with zero tables; its payoff is at 1.2).
I gate these in my implementation diff review. One genuine gap found → A4 below.

## 3. Amendments (binding)

- **A1 — `alembic/versions/.gitkeep` committed** (resolves architecture.md's
  self-contradictory tree comment). Issued before planning.
- **A2 — root README "Run the API locally" section**; backend-engineer owns all root
  files incl. new `docker-compose.yml` (0.1 §1.1 ownership rule carried forward).
  Issued before planning.
- **A3 — compose host port 5433** (architecture §8's "5533" is a typo; 5433 chosen
  over 5432 as homebrew-collision insurance). Issued before planning.
- **A4 (new) — QA adds a README check.** qa-checklist.md has no check for A2. Before
  /test, qa-engineer adds TC-F4: root README contains the "Run the API locally"
  section, mentioning port 5433 and the `docker compose down -v` caveat for
  `budget_test`. Without this, the one amendment with no automated or checklist
  coverage would rely purely on my diff review — exactly how 0.1's amendment 2.1
  slipped.
- **A5 (new) — declare the 503 in OpenAPI.** The route sets 503 via
  `Response.status_code`, which FastAPI does not reflect in the schema — the
  degraded branch would be invisible to 0.3's generated client. Add
  `responses={503: {"model": HealthResponse, "description": "Database unavailable"}}`
  to the route decorator. One line, makes the committed contract (§6 table) and the
  published schema identical. QA TC-B5 extends: `.paths."/health".get.responses`
  contains both `"200"` and `"503"`.
- **A6 (new) — conftest fail-fast must be time-capped.** `_require_test_db` must
  build its probe engine via the same `build_engine(settings)` (inheriting
  `connect_args={"timeout": 2}`), not a bare `create_async_engine`. A stopped
  compose port refuses instantly, but a black-holed/hung DB would otherwise make the
  "fail-fast" check hang toward 60s, violating TC-G1's "fast, clear failure".

## 4. Per-amendment checklist (explicit, per 0.1 retro)

| Amendment | In plan.md | In qa-checklist.md | Verdict |
|---|---|---|---|
| A1 `.gitkeep` | ✓ step 10 | ✓ TC-C3 ("only .gitkeep remaining", git-clean check) | covered |
| A2 README + root ownership | ✓ steps 11, 16 | ✗ → **A4 adds TC-F4** | covered after A4 |
| A3 port 5433 | ✓ steps 11, 12 | ✓ preconditions, TC-F1 (explicitly fails on 5432/5533), TC-E4 | covered |
| A5 OpenAPI 503 (new this review) | → backend adds to step 8 | → QA extends TC-B5 | to be folded in at /implement |
| A6 capped fail-fast (new this review) | → backend adds to conftest spec | ✓ TC-G1 already asserts "fast" | to be folded in at /implement |
| Carry-forward: scaffold-lifetime placeholder deletion (0.1 §1.3) | ✓ step 17 (deleted, `__version__` test dies unreplaced) | ✓ TC-A2 (escalates if present) | covered |

Implementation report at /implement must check off A1–A6 + the carry-forward
individually — that is the process fix from the 0.1 retro.

## 5. Risky spots — senior-lead's own verification

1. **pytest-asyncio loop scope vs lifespan engine.** Plan's shape is correct:
   function-scoped `client` fixture, `asyncio_mode = "auto"`,
   `asyncio_default_fixtures_loop_scope = "function"`, engine created inside
   `LifespanManager` on the test's own loop, disposed in lifespan teardown. The
   classic "Future attached to a different loop" failure is structurally avoided.
   (`asyncio_default_fixtures_loop_scope` requires pytest-asyncio ≥ 0.24; floor is 0.25.)
2. **alembic env.py sourcing Settings.** Sound: no `sqlalchemy.url` in ini, engine
   built from `get_settings().database_url`, `target_metadata = Base.metadata` via the
   `budget_api.models` re-export hook (becomes load-bearing at 1.2). The CWD-relative
   `.env` is a real footgun, correctly mitigated by "all alembic/uv commands run from
   apps/api" (documented in README per A2). src-layout import works because uv sync
   installs the project into the venv.
3. **503-with-typed-body.** Setting `Response.status_code` (not `HTTPException`) is
   the right call — same `HealthResponse` shape in both cases per §6. Exception net
   `(SQLAlchemyError, TimeoutError, OSError)` covers wrapped DBAPI errors, the
   wait_for cap, and raw socket errors. Residual defect was schema-only → fixed by A5.
4. **Compose init-script one-shot.** `budget_test` exists only if the init script ran
   at first volume init; plan documents `down -v` in README and its Risks. QA TC-G1
   plus the conftest fail-fast make the failure mode self-explaining. Accepted.
5. **TC-B3 pool recovery nuance (note to QA, not a defect):** after
   `docker compose start postgres`, the FIRST request may still 503 once — SQLAlchemy
   invalidates the stale pooled connection on that failure and reconnects next
   acquisition. The checklist's 10-iteration poll absorbs this; a single interim 503
   during the poll is expected behavior, not a FAIL. `pool_pre_ping` is deliberately
   not added — the health endpoint's try/except is the ping.

## 6. Decisions made this grooming (PM may veto, no answer required)

- Five-layer skeleton with `domain/`/`services/` as docstring-contract packages;
  flat `app.py`/`config.py`/`db.py`; no repositories layer until 1.3–1.4 justifies it.
- Engine + sessionmaker lifespan-scoped on `app.state`; `create_app(settings=None)`.
- Settings: single `database_url` field, no env prefix (Railway/Render inject
  `DATABASE_URL` verbatim at 1.7), `.env` + committed `.env.example`.
- Naming convention on `Base.metadata` NOW (only churn-free moment — before any table).
- Alembic: async template, URL solely from Settings, NO empty initial revision
  (`alembic check` + TC-C3's empty-autogenerate probe prove wiring; 1.2 writes 0001);
  alembic in main deps so the image can migrate at 1.7.
- `/health`: one endpoint (no liveness/readiness split), via the production
  `get_session` dependency, `200 ok/ok` vs `503 degraded/unavailable`.
- Local Postgres: root docker-compose (`postgres:17-alpine`), shared instance,
  separate `budget_test` DB for tests; testcontainers rejected (per-run startup cost
  for isolation we don't need solo); SQLite rejected outright (prod parity).
- Tests hit real Postgres, no mocks; exactly two tests; placeholder deleted;
  `__version__` survives only because `FastAPI(version=...)` uses it.
- Ruff: `E W F I UP B C4 SIM RUF ASYNC`; bugbear `extend-immutable-calls` for
  FastAPI instead of blanket B008 ignore; no per-file-ignores yet.
- Dockerfile: multi-stage uv, context `apps/api` (API is Python-self-contained),
  non-root uid 1000, alembic files in image, `--factory` CMD shared with dev script.
- Version pins: `>=` floors + uv.lock freeze (0.1 precedent).

## 7. Open questions for the PM (veto-style; non-blocking, defaults apply if unanswered)

1. **Typechecker: pyright vs mypy** (the explicitly deferred 0.2 decision).
   **Recommendation: pyright** — editor parity (Pylance) is decisive for a solo dev;
   SQLAlchemy 2.0 `Mapped[]` support is equal in both (the mypy plugin era is over);
   pydantic works natively via `dataclass_transform`; faster. Config: strict on
   `src/`, standard on `tests/`, alembic excluded from pyright but ruff-covered.
   mypy's only edge (pydantic plugin extras) is marginal.
2. **Compose Postgres host port 5433 vs conventional 5432.**
   **Recommendation: 5433** — homebrew postgres binaries exist on this machine; a
   silent 5432 collision is a time sink, and the port lives in exactly one committed
   place (`.env.example`) plus compose.

## 8. QA scope note

web-qa / mobile-qa remain NOT invoked: no client changes (0.3 starts contract
consumption). qa-engineer's 20-check list (becoming 21 with TC-F4 per A4) is the
/test gate; my diff review gates the review-only structural items listed in §2.
