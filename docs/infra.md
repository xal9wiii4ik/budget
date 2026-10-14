# infra.md — local environment (THIS machine)

## Docker compose (root `docker-compose.yml`)
- `postgres` (17-alpine): user/pass/db `budget`; host port `${POSTGRES_HOST_PORT:-5433}:5432`.
  - THIS machine: gitignored root `.env` sets `POSTGRES_HOST_PORT=5443` → container `budget-postgres-1` on **5443**. The committed default 5433 is a FOREIGN container (`ms-menu-v2-postgres-test-1`) — never touch it.
  - `docker/postgres/init/` creates both `budget` and `budget_test` DBs.
- `minio`: host ports **9010** (S3) / **9011** (console), minioadmin/minioadmin; `minio-init` creates private bucket `receipts`.

## Web container — the same-origin proxy
- `web` (nginx) serves the SPA on **5173** and proxies `/api/` → `api:8000`, `/storage/` → `minio:9010`, and (since `mcp-remote`) `= /mcp` + the prefix `/.well-known/oauth-` → `api:8000`. The last two answer 404 in dev unless the API has `PUBLIC_BASE_URL` set (`docs/mcp.md`). The bundle is built with `VITE_API_URL=/api` (relative), so nothing host-specific is baked in: the same image works on `localhost`, from a phone on the LAN (`http://<Mac LAN IP or MacBook-Pro-Nikita.local>:5173`) and after deploy, with no CORS involved.
- Presigned storage links are signed for `minio.localhost:9010`; nginx rewrites them to `/storage/…` in API JSON passing through `/api/` (`sub_filter`) and serves `/storage/` with `Host: minio.localhost:9010`, so the signature stays valid. Clients hitting **8010** directly (phone app, MCP) get the original links.
- uvicorn runs with `--forwarded-allow-ips='*'` so per-IP rate limits see the client, not nginx. With `*` uvicorn takes the LEFTMOST `X-Forwarded-For` entry, i.e. it trusts any sender — on a public deploy publish only the TLS front, never 8010. (Docker Desktop on macOS shows every outside client as `192.168.65.1`.)
- `nginx.conf` forwards `X-Forwarded-Proto` from the upstream proxy's header when one exists (`map … $fwd_proto`), else its own `$scheme` — so dev stays `http` and behind Caddy the API sees `https`.

## Production (netcup VPS) — `docs/deploy.md`
- `docker-compose.prod.yml` is STANDALONE (project `budget-prod`), not an override: caddy (`caddy:2-alpine`, `deploy/Caddyfile`, Let's Encrypt for `SITE_DOMAIN`; `localhost` → internal CA) is the ONLY service with `ports:`; web/api/postgres/minio publish nothing. Real-IP chain Caddy (overwrites client XFF) → nginx (appends) → uvicorn (leftmost). Secrets from the server's `.env` (`.env.prod.example`; `${VAR:?}` makes `compose config` refuse a blank one).
- Three settings must stay byte-identical to the dev file: `minio.localhost` alias, `--address ":9010"`, `S3_ENDPOINT_URL=http://minio.localhost:9010` (nginx `sub_filter` hardcodes the host).
- Local verification of the prod stack: `docker compose --env-file <scratch>/.env.prod.qa -f docker-compose.prod.yml -p budget-prod-qa up -d --build` with `SITE_DOMAIN=localhost CADDY_HTTP_PORT=8480 CADDY_HTTPS_PORT=8443`; open `https://localhost:8443` directly (the :80 redirect targets 443). Probes: `.tasks/deploy/qa-checklist.md` (P1–P18) + `qa-web-checklist.md`. Tear down with `down -v --rmi local`.
- Ops scripts `deploy/{bootstrap,update,backup,restore,migrate-local-data}.sh` take `COMPOSE_FILE` / `COMPOSE_PROJECT_NAME` / `ENV_FILE` from the environment, so the same scripts run against the QA stand.
- A phone on plain `http://` can "Add to Home Screen" and opens standalone, but it is not a secure context: no service worker, so no offline page. That needs HTTPS (deploy, or Tailscale serve).

## API server
- Dev server on port **8010** (`8000` is a foreign process): `cd apps/api && uv run uvicorn budget_api.app:create_app --factory --reload --port 8010`.
- Config from gitignored `apps/api/.env` (DATABASE_URL on 5443, JWT_SECRET; ANTHROPIC_API_KEY absent → AI features answer 503 AI_NOT_CONFIGURED until it lands).
- Web Push: `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT=mailto:…` in `apps/api/.env` (all three or the feature is OFF: `GET /push/config` → `enabled:false`, Settings shows the server-off arm). Generate a pair from `apps/api`: `uv run python -c 'from py_vapid import Vapid, b64urlencode; from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat; v = Vapid(); v.generate_keys(); print("VAPID_PUBLIC_KEY=" + b64urlencode(v.public_key.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint))); print("VAPID_PRIVATE_KEY=" + b64urlencode(v.private_key.private_numbers().private_value.to_bytes(32, "big")))'`. Rotating the pair kills every existing subscription (the web drops them on its next Settings visit). QA stands add `PUSH_ALLOW_INSECURE_ENDPOINTS=true` so a `http://127.0.0.1` stub push service passes the subscribe guard — never in prod. Delivery to a phone needs HTTPS (deploy or Tailscale serve).
- Mobile dev clients also target :8010 (baseUrl.ts DEV_API_PORT).

## Tests
- API: `uv run pytest` from `apps/api` (conftest defaults to 5443, this machine's own Postgres). `TEST_DATABASE_URL` still overrides it.
- Test/live servers for QA: run with `FX_SCHEDULER_ENABLED=false RECURRING_SCHEDULER_ENABLED=false PUSH_SCHEDULER_ENABLED=false` (otherwise boot probes/cron jobs fire). pytest itself constructs apps with all three gates false — no override needed for the suite.
- Monorepo gates: `pnpm turbo lint typecheck test` (web/shared/api-client are vitest; shared runs under TZ=America/Los_Angeles).
- QA seed users: `qa-*@budgetqa.dev` / `Qa!Test1234`.
- Remote-MCP/OAuth stands (mcp-remote): the FULL flow (Claude Code / the Python SDK client) is honest only on the prod-like compose stand — `PUBLIC_BASE_URL=https://localhost:8443` in the scratch env, Caddy's internal CA exported from the container (`.tasks/mcp-remote/qa-checklist.md`), because the `/api/` prefix the metadata publishes exists only behind nginx. Browser journeys of the consent page and Settings need no TLS: API on 8021 started with `PUBLIC_BASE_URL=http://localhost:5199 CORS_ORIGINS='["http://localhost:5199"]'` + vite on 5199 (`pnpm --filter @budget/web dev --port 5199 --strictPort`, no `--` — pnpm swallows it); a pending consent request is manufactured with curl against `/oauth/register` + `/oauth/authorize` on 8021 (`.tasks/mcp-remote/qa-web-checklist.md`). Without `PUBLIC_BASE_URL` the API registers no OAuth/`/mcp` route at all.
- Known flake: stale-takeover receipts test under parallel turbo load.
- AI categorization stand (ai-layer): no `.env` line is needed for the default (`LLM_PROVIDER=anthropic` + empty key → every import reads `ai_status=not_configured`, byte-identical to before). A deterministic stand without a key: `LLM_PROVIDER=fake` (a category whose NAME is a case-insensitive substring of the row text → that category at 0.9 with reason "name match", else the row is flagged; a row containing `LLMFAIL` makes the provider fail). Real run: `ANTHROPIC_API_KEY=…` (shared with receipts/advisor; model `CATEGORIZE_MODEL`, default `claude-haiku-5-5`) or `LLM_PROVIDER=ollama` + `OLLAMA_BASE_URL`/`OLLAMA_MODEL` (localhost:11434, not installed on this machine). Quota knob for QA: `CATEGORIZE_DAILY_ROW_QUOTA=5/day`. The ai-layer QA stand was API 8021 (`fake`) + 8022 (`off`) + vite 5199 with `VITE_API_URL=http://localhost:8021` as a SHELL override (vite's `.env` points at 8010), on its own DB `budget_qa_ai_layer` — `.tasks/ai-layer/qa-checklist.md`.
- Evals (`apps/api/evals/`, README there): `uv run python evals/run.py --provider fake|anthropic|ollama --mode live|record|replay`; the committed replay fixture and report are SYNTHETIC (recorded from the fake provider) and `tests/test_evals_regression.py` replays it with no network and no DB. The anonymizer's input `.tasks/ai-layer/real-eval-local.csv` and its review table `real-anonymize-review-local.md` are gitignored (`real-*-local.*`).
- CI (GitHub Actions, `.github/workflows/`): `ci-api.yml` = uv sync --frozen → ruff check/format → pyright → alembic upgrade head + `alembic check` → pytest against a `postgres:17-alpine` service (`POSTGRES_DB=budget_test`, env `TEST_DATABASE_URL`/`DATABASE_URL`/`JWT_SECRET` beat `apps/api/.env`); `ci-js.yml` = pnpm frozen install → `turbo lint typecheck test --filter=!@budget/api`. Path-filtered per workflow — `apps/api/openapi.json` is in the JS filter because of the drift test. Actions pinned to commit SHAs; `act` is not installed here, verify by running the step commands (record: `.tasks/ci-readme/qa-checklist.md`).

## Contract regen
- `pnpm openapi` (root; = `turbo run generate`) produces BOTH artifacts:
  - `apps/api/openapi.json` via `python -m budget_api.openapi_export openapi.json`;
  - `packages/api-client/src/generated/schema.d.ts` via `packages/api-client/scripts/generate.mjs` (openapi-typescript over that json).
- Both must land in the SAME commit; a drift test in api-client regenerates and diffs, so a stale pair fails CI/gates.

## iOS simulator
- Device: iPhone 17 Pro, iOS 26.5, UDID `97EA8741-3A57-4056-89BA-A88651C0EFD0`, ru-RU locale; Expo Go 57.0.9.
- `idb` is installed and is the driver (no full Xcode on this machine); screenshots/taps via idb against the booted simulator.
- Evidence conventions + manual-device TCs: `.tasks/mobile-mvp/qa-mobile-checklist.md`.
