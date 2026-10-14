# ci-readme — QA record

`act` and `actionlint` are not installed on this machine; the gate was the
exact step commands run locally (2026-10-14), against a throwaway
`postgres:17-alpine` on host port 5444 (same image/env as the CI service;
container removed afterwards). Senior-lead re-resolved two of the four pinned
SHAs independently (`setup-uv` v10.3.0, `pnpm/action-setup` v6.1.0) — match.

## ci-api.yml — local run

| Step | Result | Note |
|---|---|---|
| `uv sync --frozen` | pass | |
| `uv run ruff check .` | pass | |
| `uv run ruff format --check .` | pass | |
| `uv run pyright` | pass | 9 s |
| `uv run alembic upgrade head` | pass | probe DB's `alembic_version` = 0017 → env vars beat `apps/api/.env` |
| `uv run alembic check` | pass | "No new upgrade operations detected" |
| `uv run pytest` | pass | 746 passed, 200 s |

## ci-js.yml — local run

| Step | Result | Note |
|---|---|---|
| `pnpm install --frozen-lockfile` | pass | pnpm 11.17.0 = `packageManager` |
| `pnpm turbo lint typecheck test --filter=!@budget/api --force` | pass | 12/12 tasks; vitest: shared 133, web 274, api-client 76 (drift test in), mobile 95; mobile lint green |

## Not verifiable locally — watch on the first real run (PM)

- [ ] `setup-uv` cache save on run 1, restore on run 2 (`cache-dependency-glob: apps/api/uv.lock`).
- [ ] `setup-node` `cache: pnpm` restore (pnpm/action-setup runs first — required).
- [ ] Service container health gate (`pg_isready -U budget -d budget_test`) passes before the first step.
- [ ] Runner Node resolves from `.nvmrc` (22); local run was Node 24.7.
- [ ] Path filters: a docs-only push triggers neither workflow; an `apps/api/openapi.json` change triggers BOTH.
- [ ] Concurrency: a second push to the same ref cancels the in-flight run.
- [ ] Wall-clock under the 20-min job timeout (local: pytest 200 s + pyright 9 s + uv sync cold).
- [ ] `uv run pyright` on a cold runner downloads the pyright npm bundle — first-run slowness is expected, not a fault.
