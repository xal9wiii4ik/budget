# ci-readme — grooming (light)

Tier: **STANDARD** (no DB/money/auth/contract change; artefacts are `.github/` +
`README.md` + docs cross-links). No architect. QA = local execution of the exact
workflow commands; `act` is not installed on this machine, so the first real
run is watched by the PM after push.

## Decisions

1. **Two workflow files, not one** — `ci-api.yml` and `ci-js.yml`. GitHub's
   `on.<event>.paths` filter is per-workflow; per-job filtering would need a
   third-party action. Two files give path filters for free and keep each run
   lean (free minutes on a private repo).
   - api paths: `apps/api/**`, `.github/workflows/ci-api.yml`.
   - js paths: `apps/web/**`, `apps/mobile/**`, `packages/**`, root toolchain
     files (`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`,
     `turbo.json`, `tsconfig.base.json`, `eslint.config.mjs`, `.npmrc`,
     `.nvmrc`), **plus `apps/api/openapi.json`** — the api-client drift test
     regenerates `schema.d.ts` from it, so a contract change must trigger JS.
2. **API job**: `services.postgres` = `postgres:17-alpine`, user/pass `budget`,
   `POSTGRES_DB=budget_test` (what `docker/postgres/init` creates locally),
   published on 5432. Env: `TEST_DATABASE_URL` + `DATABASE_URL` →
   `postgresql+asyncpg://budget:budget@localhost:5432/budget_test`,
   `JWT_SECRET=ci-not-a-secret` (conftest's own secret is also a dummy).
   Steps: `uv sync --frozen` → `ruff check .` → `ruff format --check .` →
   `pyright` → `alembic upgrade head` → `alembic check` → `pytest`.
   Schedulers: pytest builds every app with the three gates False (conftest),
   alembic never boots the app — no env needed; not adding noise.
   The receipts "stale-takeover" flake (docs/infra.md) is a parallel-turbo
   artefact; the API job runs pytest directly, not under turbo.
3. **JS job**: pnpm/action-setup (reads `packageManager`) BEFORE setup-node
   (`cache: pnpm`, `node-version-file: .nvmrc`), `pnpm install
   --frozen-lockfile`, `pnpm turbo lint typecheck test --filter=!@budget/api`.
   No Python in this job (drift test = openapi-typescript over the json).
   Mobile lint is included (root `eslint.config.mjs` covers it) if green locally.
4. Hygiene: every `uses:` pinned to a full commit SHA with a `# vX.Y.Z`
   comment, resolved via `gh api`; `permissions: contents: read` at workflow
   level; `concurrency` group per workflow+ref with `cancel-in-progress`;
   `timeout-minutes` on every job.
5. **Local verification** = run the exact step commands against a throwaway
   `postgres:17-alpine` on host port 5444 (`docker run`, removed afterwards).
   5443 belongs to the parallel `ai-layer` scope; never a full pytest on a
   shared DB (serialisation policy).
6. README: delegated after the privacy scan so it never cites a flagged path.
   Facts only; "Evals" section is an explicit placeholder.

## Estimate (agent-minutes)
- CI write 10–15 / gates 10–15 (pytest ~1200 tests) / verification: one fix
  round if `alembic check` reports autogenerate noise.
- Privacy scan: 10 (read-only).
- README: 15–20 write / 5 review.

## Out of scope
`apps/api`, `apps/web`, `apps/mobile`, `packages/*` code — owned by `ai-layer`
today. If a workflow command is red for a reason inside those trees, STOP and
report, do not fix.
