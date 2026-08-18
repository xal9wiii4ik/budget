# backend.md — apps/api map

Src root: `apps/api/src/budget_api/`. App factory `app.py:create_app` (engine/sessionmaker/settings/limiter on `app.state`, built in lifespan).

## Routers (`routers/`, mounted in app.py)
- `/health` — DB probe; 503 with HealthResponse body when DB down; never blocks boot.
- `/auth` — login/refresh/logout + fastapi-users register/reset-password; slowapi limits (login 10/min, register 5/h, forgot 5/h) via `prime_rate_limit` dep.
- `/users` — stock fastapi-users router: GET/PATCH `/me`; `/{id}` superuser-gated, dead-but-harmless (no superusers).
- `/categories` — list (archived-inclusive)/create/patch; seed system rows read-only (`SYSTEM_CATEGORY_READONLY`).
- `/transactions` — CRUD + `GET /summary` + `GET /export` (streaming CSV, BOM, content-disposition); `/summary` and `/export` declared BEFORE `/{id}` (route-order landmine).
- `/fx` — `GET /convert` preview (nearest-previous daily rate).
- `/goals` — CRUD + archive; `/{id}/contributions` CRUD; `/{id}/progress` series.
- `/recurring` — template CRUD (no pagination/filters by design, D10).
- `/limits` — `GET` (month-scoped, with spent), `PUT`/`DELETE` per category.
- `/stats` — `/summary`, `/monthly` (trailing window, NOT period-scoped), `/top-merchants`; period grammar in query (month|quarter|year|custom). AUTH-FIRST param order is load-bearing.
- `/receipts` — `POST` (presigned MinIO PUT, 201; 30/min per user), `GET /{id}` (poll), `POST /{id}/parse` (202, claim via UPDATE…RETURNING; 10/min;100/day per user).
- `/advisor` — `POST /ask` SSE stream (`response_class=StreamingResponse`, no JSON 200 arm — O-8); `Depends(require_ai_configured)`; 5/min;20/day per user (`user_rl_key`).

## Top-level helpers
- `ai_gate.py` — `require_ai_configured`: 503 `AI_NOT_CONFIGURED` when `anthropic_api_key` empty. ONE key shared by receipts+advisor. Receipts call it INLINE (preserves 401-before-503 and quota counting); advisor uses `Depends` (unkeyed 503 consumes no quota).
- `rate_limit.py` — process-global slowapi limiter; per-app enable/limits via contextvar primed by `prime_rate_limit`; storage isolated per app by `rate_limit_scope` uuid key prefix; headers disabled; 429 body `{"detail": "RATE_LIMITED"}`.
- `category_access.py` — user-scoped category load; foreign/missing → one `None` path (no-oracle).
- `auth.py` (fastapi-users wiring), `config.py` (Settings, all env), `db.py`, `enums.py`, `openapi_export.py` (contract exporter).

## services/
- `advisor.py` — Anthropic streaming ask (Sonnet `advisor_model`, 2048 tok, 120s).
- `advisor_context.py` — PURE context builder: 3-month aggregates + goals; never raw transactions.
- `fx_rates.py` — `FxRateFetcher`: frankfurter (EUR-cross) + NBRB (BYN/RUB); base URLs are settings (stub-able).
- `fx_jobs.py` — `fetch_daily_rates` job + `catch_up_needed` boot probe.
- `fx_lookup.py` — nearest-previous-date rate lookup.
- `receipt_parser.py` — Haiku OCR pipeline: size gate 5_000_000 B (`IMAGE_TOO_LARGE` 422 pre-claim), claim, parse, error taxonomy; stale re-claim after 300s > 90s timeout.
- `recurring_jobs.py` — `materialize_due` (idempotent daily materialization).
- `storage.py` — MinIO presign PUT/GET (bucket `receipts`).
- `goal_reads.py` / `profile_reads.py` / `tx_totals.py` — read helpers (progress, self-healing profile, summary math).

## domain/ (pure, no IO)
- `money.py` — minor↔decimal at currency exponent; exponent table = SERVER TWIN of `packages/shared/src/currencies.ts`, drift pinned by `tests/test_currency_exponents_sync.py`.
- `periods.py` — /stats period grammar (year envelope); `fx.py` conversion math (Decimal); `goals.py` progress; `merchant.py` normalization; `recurrence.py` due-date math.

## models/ + migrations (alembic/versions/)
- models: user, refresh_token, profile, category, transaction, receipt, merchant_category_map, exchange_rate, goal (+contributions), recurring_template, category_limit.
- `0001` users + refresh_tokens.  `0002` core tables (profiles/categories/transactions).
- `0003` seed system categories (19 frozen UUIDs, `user_id IS NULL`) + backfill.
- `0004` receipts + merchant_category_map.  `0005` exchange_rates, goals, tx base-snapshot columns.
- `0006` recurring_templates + category_limits.

## Scheduler (lifespan, APScheduler)
- Built only if a gate is on; whole pytest suite runs with both gates false (no scheduler object at all).
- fx: cron 17:30 UTC (`FX_SCHEDULER_ENABLED`, `fx_fetch_hour/minute_utc`), misfire grace 3600 coalesced; boot catch-up probe → run-now job; backfill 400 days on empty provider.
- recurring: cron 00:30 UTC (`RECURRING_SCHEDULER_ENABLED`), `materialize_due`; plus an UNCONDITIONAL run-now boot catch-up job (D5) — a restart materializes today's due occurrences immediately.

## CORS (app.py, gotcha)
- `allow_methods` is a HAND-LISTED verb set — a new HTTP verb served to the browser MUST be added there or every preflight for it gets 400 (bit us live: `PUT /limits` shipped while the list ended at DELETE). Pinned by `tests/test_cors.py::test_preflight_allows_every_verb_the_api_serves`, which derives the verb set from the exported OpenAPI.

## Error envelope
- Domain errors: `HTTPException(detail="STRING_CODE")` — e.g. `CATEGORY_NOT_FOUND`, `CATEGORY_ARCHIVED`, `CATEGORY_NOT_EXPENSE`, `GOAL_NOT_FOUND`, `CONTRIBUTION_EXCEEDS_SAVED`, `RECEIPT_PROCESSING`, `IMAGE_TOO_LARGE`, `LOGIN_BAD_CREDENTIALS`, `REFRESH_TOKEN_INVALID`, `RATE_LIMITED`, `AI_NOT_CONFIGURED`, `STORAGE_UNAVAILABLE`.
- 422 pattern: routes declare `_UNPROCESSABLE` with raw `anyOf` [DomainError-schema, HTTPValidationError] — honest union without mangling the generated component.
- No-oracle 404s: foreign and missing ids share ONE code path and a byte-identical body; logout always 204; forgot-password never reveals account existence.
