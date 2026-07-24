# Task: api-skeleton (roadmap 0.2)

Original PM description, verbatim:

> TASK (id: `api-skeleton`, roadmap item 0.2): Turn the empty `apps/api` package into a runnable FastAPI skeleton. The monorepo scaffold (task 0.1) is committed at f55cdeb — uv-managed src-layout package `budget_api`, pytest+ruff wired into turbo via @budget/api scripts (typecheck and dev are currently `exit 0` no-ops that this task must make real).
>
> Scope per roadmap 0.2:
> - FastAPI app with app-factory pattern, internal layering per architecture doc: routers/ domain/ services/ models/ schemas/
> - Settings via env (pydantic-settings), .env.example
> - SQLAlchemy 2.0 async + session dependency, Base model class; Alembic initialized and wired (async migrations), zero real tables yet (users/auth is task 1.1-1.2)
> - A real healthcheck endpoint (e.g. GET /health with DB ping) — first real endpoint, replaces the placeholder test with real tests
> - `dev` script becomes a real uvicorn command; `typecheck` script becomes real (mypy vs pyright — the deferred 0.2 decision, decide with justification)
> - Dockerfile for the API (roadmap lists it in 0.2)
> - Local Postgres strategy for dev/test — decide (docker compose service vs testcontainers vs sqlite-for-tests-only; note the architecture doc mandates Postgres in prod)
> - Ruff rule set expansion (deferred from 0.1)
>
> Team: your call, justify it. qa-engineer IS warranted now (there's a real endpoint). architect likely warranted (module layering + DB session lifecycle + migration strategy are structural). frontend/mobile NOT needed (no client changes).
>
> Process notes from the PM: proceed without waiting for confirmation; artifacts to .tasks/api-skeleton/; keep it lean — no auth, no business tables, no CI. Surface open questions per Phase 3.5 with recommendations. Run your Phase 4 review INCLUDING an explicit per-amendment checklist (the 0.1 retro found an amendment slipped through unchecked). Return: team + reasoning, artifact paths, open questions with recommendations. Do NOT start implementation.

## Binding carry-forward from 0.1 (grooming-review.md)

- **Scaffold-lifetime placeholder rule (§1.3):** `apps/api/tests/test_placeholder.py`
  MUST be deleted or absorbed by this task's first real tests. Non-optional.
- Ruff was set to minimal `["E","F","I"]` explicitly deferring expansion to 0.2
  alongside the mypy-vs-pyright decision (0.1 open question 5).
- Root `.gitignore` is the only hand-maintained ignore file (tool-owned generated
  ignores excepted).

## Environment facts (verified at grooming time)

- Docker daemon running: 24.0.6 (server responds).
- Homebrew `psql`/`postgres` binaries present on the machine.
- uv 0.11.32; scaffold at f55cdeb; `@budget/api` turbo inputs cover
  `src/** tests/** pyproject.toml uv.lock`.
