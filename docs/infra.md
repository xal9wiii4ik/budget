# infra.md — local environment (THIS machine)

## Docker compose (root `docker-compose.yml`)
- `postgres` (17-alpine): user/pass/db `budget`; host port `${POSTGRES_HOST_PORT:-5433}:5432`.
  - THIS machine: gitignored root `.env` sets `POSTGRES_HOST_PORT=5443` → container `budget-postgres-1` on **5443**. The committed default 5433 is a FOREIGN container (`ms-menu-v2-postgres-test-1`) — never touch it.
  - `docker/postgres/init/` creates both `budget` and `budget_test` DBs.
- `minio`: host ports **9010** (S3) / **9011** (console), minioadmin/minioadmin; `minio-init` creates private bucket `receipts`.

## API server
- Dev server on port **8010** (`8000` is a foreign process): `cd apps/api && uv run uvicorn budget_api.app:create_app --factory --reload --port 8010`.
- Config from gitignored `apps/api/.env` (DATABASE_URL on 5443, JWT_SECRET; ANTHROPIC_API_KEY absent → AI features answer 503 AI_NOT_CONFIGURED until it lands).
- Mobile dev clients also target :8010 (baseUrl.ts DEV_API_PORT).

## Tests
- API: `uv run pytest` from `apps/api` (conftest defaults to 5443, this machine's own Postgres). `TEST_DATABASE_URL` still overrides it.
- Test/live servers for QA: run with `FX_SCHEDULER_ENABLED=false RECURRING_SCHEDULER_ENABLED=false` (otherwise boot probes/cron jobs fire). pytest itself constructs apps with both gates false — no override needed for the suite.
- Monorepo gates: `pnpm turbo lint typecheck test` (web/shared/api-client are vitest; shared runs under TZ=America/Los_Angeles).
- QA seed users: `qa-*@budgetqa.dev` / `Qa!Test1234`.
- Known flake: stale-takeover receipts test under parallel turbo load.

## Contract regen
- `pnpm openapi` (root; = `turbo run generate`) produces BOTH artifacts:
  - `apps/api/openapi.json` via `python -m budget_api.openapi_export openapi.json`;
  - `packages/api-client/src/generated/schema.d.ts` via `packages/api-client/scripts/generate.mjs` (openapi-typescript over that json).
- Both must land in the SAME commit; a drift test in api-client regenerates and diffs, so a stale pair fails CI/gates.

## iOS simulator
- Device: iPhone 17 Pro, iOS 26.5, UDID `97EA8741-3A57-4056-89BA-A88651C0EFD0`, ru-RU locale; Expo Go 57.0.9.
- `idb` is installed and is the driver (no full Xcode on this machine); screenshots/taps via idb against the booted simulator.
- Evidence conventions + manual-device TCs: `.tasks/mobile-mvp/qa-mobile-checklist.md`.
