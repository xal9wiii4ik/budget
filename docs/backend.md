# backend.md — apps/api map

Src root: `apps/api/src/budget_api/`. App factory `app.py:create_app` (engine/sessionmaker/settings/limiter on `app.state`, built in lifespan).

## Routers (`routers/`, mounted in app.py)
- `/health` — DB probe; 503 with HealthResponse body when DB down; never blocks boot.
- `/auth` — login/refresh/logout + fastapi-users register/reset-password; slowapi limits (login 10/min, register 5/h, forgot 5/h) via `prime_rate_limit` dep.
- `/users` — stock fastapi-users router: GET/PATCH `/me`; `/{id}` superuser-gated, dead-but-harmless (no superusers).
- `/categories` — list (archived-inclusive)/create/patch; seed system rows read-only (`SYSTEM_CATEGORY_READONLY`).
- `/transactions` — CRUD + `GET /summary` + `GET /export` (streaming CSV, BOM, content-disposition); `/summary` and `/export` declared BEFORE `/{id}` (route-order landmine). POST takes optional `client_id` (UUID): a replay with the same client_id returns the STORED row with 200, not a duplicate (B-1 idempotency: select-first + partial unique index + IntegrityError recovery). Every tx belongs to an account (`account_id` required); server STAMPS `currency` from the account, a disagreeing sent value → 422 `ACCOUNT_CURRENCY_MISMATCH`. Third kind `transfer` = ONE row with `counter_account_id`/`counter_amount_minor`/`counter_currency` (stamped from target); no category, base-snapshot pair NULL (CHECKs in 0008); read-only `transfer_rate` computed on read (Decimal string, major units, ROUND_HALF_UP; null when both legs same currency). PATCH `kind` to/from transfer → 422 `KIND_CHANGE_UNSUPPORTED`. Filter `?account_id=` matches EITHER leg (an account's history = both legs); `?kind=` works for transfer. CSV includes transfers: columns `account, counter_account, counter_amount` (counter formatted at TARGET currency exponent), base cells empty.
- `/accounts` — list/create/patch (NO delete — archive only, like categories); archived-inclusive list, each row carries computed `balance_minor` (§2 of scope architecture: starting + income − expense − transfer-out + transfer-in, one grouped SQL, all terms already in the account's currency). `currency` immutable on PATCH → 422 `ACCOUNT_CURRENCY_IMMUTABLE`; writes to archived account (either leg) → 422 `ACCOUNT_ARCHIVED`; types `card|cash` (enums.py AccountType).
- `/fx` — `GET /convert` preview (nearest-previous daily rate).
- `/goals` — CRUD + archive; `/{id}/contributions` CRUD; `/{id}/progress` series.
- `/recurring` — template CRUD (no pagination/filters by design, D10). `account_id` required (materializer books onto it); `kind` stays expense|income — recurring transfers unsupported in v1 (422). PATCH can MOVE a template to another account (B3): currency restamped from the new account, "new account + old currency" refused whole (`ACCOUNT_CURRENCY_MISMATCH`), watermark untouched. A move ACROSS currencies must carry `amount_minor` in the same PATCH — 422 `AMOUNT_REQUIRED_ON_CURRENCY_CHANGE`, checked BEFORE the currency-echo gate (the stored integer is minor units of the OLD stamp; restamping alone would silently redefine what the job books every period).
- `/limits` — `GET` (month-scoped, with spent), `PUT`/`DELETE` per category.
- `/stats` — `/summary`, `/monthly` (trailing window, NOT period-scoped), `/top-merchants`; period grammar in query (month|quarter|year|custom). AUTH-FIRST param order is load-bearing.
- `/receipts` — `POST` (presigned MinIO PUT, 201; 30/min per user), `GET /{id}` (poll), `POST /{id}/parse` (202, claim via UPDATE…RETURNING; 10/min;100/day per user). Both `ReceiptRead` responses carry `view_url`: a presigned GET minted per read (TTL `s3_presign_get_ttl_seconds`), null while `pending` — only a status past pending proves the object exists, since the parse claim is gated on a HEAD 200 (`_UPLOAD_PROVEN_STATUSES`); no read ever does a HEAD of its own.
- `/advisor` — `POST /ask` SSE stream (`response_class=StreamingResponse`, no JSON 200 arm — O-8); `Depends(require_ai_configured)`; 5/min;20/day per user (`user_rl_key`).
- `/tokens` — PAT management (5.6): POST mint (plaintext returned ONCE, only SHA-256 stored) / GET list (metadata only, never the string) / DELETE `/{id}` soft-revoke — all JWT-ONLY (`current_active_user` imported straight from auth.py: a PAT can never mint or revoke tokens). Single exception: `GET /tokens/self` is PAT-accessible, returns `{id, scope}` of the calling token (MCP startup introspection). NO rate limit on POST yet — backlog MINOR-2 (`.tasks/mcp-server/review-s1.md`).

## Top-level helpers
- `ai_gate.py` — `require_ai_configured`: 503 `AI_NOT_CONFIGURED` when `anthropic_api_key` empty. ONE key shared by receipts+advisor. Receipts call it INLINE (preserves 401-before-503 and quota counting); advisor uses `Depends` (unkeyed 503 consumes no quota).
- `rate_limit.py` — process-global slowapi limiter; per-app enable/limits via contextvar primed by `prime_rate_limit`; storage isolated per app by `rate_limit_scope` uuid key prefix; headers disabled; 429 body `{"detail": "RATE_LIMITED"}`.
- `category_access.py` — user-scoped category load; foreign/missing → one `None` path (no-oracle).
- `account_access.py` — same pattern for accounts: foreign/missing → 404 `ACCOUNT_NOT_FOUND`; guard ORDER load-bearing: not-found BEFORE archived (a foreign archived account must answer 404, never leak `ACCOUNT_ARCHIVED`).
- `pat_auth.py` — ONE dependency `current_user_jwt_or_pat`, used by ALL data routers (categories/transactions/accounts/fx/goals/recurring/limits/stats + `GET /profile` ONLY — its PATCH and auth/users/tokens/receipts/advisor stay JWT-only); sniffs `Bearer bgt_pat_` else delegates to the stock JWT path. PAT-branch gate ORDER is load-bearing (review-s1 MAJOR-1): hash lookup (missing==revoked==inactive-owner → one 401 `TOKEN_INVALID`, no oracle; NOT audited — no token row to FK) → stash `request.state.pat` (so 403/429 refusals DO get audited) → per-token rate limit 429 (`pat_read_rate_limit` 60/min, `pat_write_rate_limit` 20/min; direct limiter-storage hit, NOT decorators) → fail-closed allowlist of (method, route.path_format) pairs → 403 `TOKEN_ENDPOINT_FORBIDDEN` (the ONLY DELETE pair is `/transactions/{transaction_id}`; accounts got exactly GET/POST/PATCH pairs — no DELETE exists to allow) → scope gate → 403 `TOKEN_SCOPE_READONLY` (GET=any scope, writes need `full`) → 60s-debounced `last_used_at` UPDATE.
- `pat_audit.py` — ASGI middleware: one `pat_audit_log` row for EVERY request carrying `request.state.pat`, including gate refusals; own short session, insert failure never fails the request; `entity_id` from the path param (PATCH/PUT/DELETE) or the POST 2xx response body (only case where the body is buffered); stores the route TEMPLATE, never the raw URL. Viewing is SQL-only in v1 (example query in packages/mcp-server/README.md).
- `auth.py` (fastapi-users wiring), `config.py` (Settings, all env), `db.py`, `enums.py`, `openapi_export.py` (contract exporter).

## services/
- `advisor.py` — Anthropic streaming ask (Sonnet `advisor_model`, 2048 tok, 120s).
- `advisor_context.py` — PURE context builder: 3-month aggregates + goals; never raw transactions.
- `fx_rates.py` — `FxRateFetcher`: frankfurter (EUR-cross) + NBRB (BYN/RUB); base URLs are settings (stub-able).
- `fx_jobs.py` — `fetch_daily_rates` job + `catch_up_needed` boot probe.
- `fx_lookup.py` — nearest-previous-date rate lookup.
- `receipt_parser.py` — Haiku OCR pipeline: size gate 5_000_000 B (`IMAGE_TOO_LARGE` 422 pre-claim), claim, parse, error taxonomy; stale re-claim after 300s > 90s timeout.
- `recurring_jobs.py` — `materialize_due` (idempotent daily materialization). Books onto `tpl.account_id` verbatim: the archived-account guard is CREATE/PATCH-time only, so a template whose account is archived AFTERWARDS keeps materializing onto it — a DECISION (B2/MINOR-1), not an oversight. Precedent: an archived category keeps receiving rows too; silently skipping in the scheduler would drop money with no user-visible refusal.
- `storage.py` — MinIO presign PUT/GET (bucket `receipts`).
- `goal_reads.py` / `profile_reads.py` / `tx_totals.py` — read helpers (progress, self-healing profile, summary math). `tx_totals.py` is THE single place transfers are excluded from money aggregates (`kind != transfer` in all three grouped series + `_bucket_three_rows`); every rider (stats, limits, tx summary, goals free balance, advisor context) is clean by construction — do NOT re-filter downstream.

## domain/ (pure, no IO)
- `money.py` — minor↔decimal at currency exponent; exponent table = SERVER TWIN of `packages/shared/src/currencies.ts`, drift pinned by `tests/test_currency_exponents_sync.py`.
- `periods.py` — /stats period grammar (year envelope); `fx.py` conversion math (Decimal); `goals.py` progress; `merchant.py` normalization; `recurrence.py` due-date math.

## models/ + migrations (alembic/versions/)
- models: user, refresh_token, profile, category, transaction, receipt, merchant_category_map, exchange_rate, goal (+contributions), recurring_template, category_limit.
- `0001` users + refresh_tokens.  `0002` core tables (profiles/categories/transactions).
- `0003` seed system categories (18 frozen UUIDs, `user_id IS NULL`) + backfill.
- `0004` receipts + merchant_category_map.  `0005` exchange_rates, goals, tx base-snapshot columns.
- `0006` recurring_templates + category_limits.  `0007` personal_access_tokens (SHA-256 `token_hash` unique, `scope` CHECK read|full, soft `revoked_at`) + pat_audit_log (append-only BigInt PK, composite ix (token_id, occurred_at)) + `transactions.client_id`.
- `0008` accounts (user-owned, NOT NULL user_id, boolean `archived`) + transactions `account_id` NOT NULL / counter-triple nullable + rebuilt `kind_valid` (expense|income|transfer) + transfer CHECKs (counter pair present iff transfer, no category, no base pair, counter != account, counter_amount > 0) + recurring_templates `account_id` NOT NULL. Tables were EMPTIED before this migration (PM decision) — no history backfill exists.

## Scheduler (lifespan, APScheduler)
- Built only if a gate is on; whole pytest suite runs with both gates false (no scheduler object at all).
- fx: cron 17:30 UTC (`FX_SCHEDULER_ENABLED`, `fx_fetch_hour/minute_utc`), misfire grace 3600 coalesced; boot catch-up probe → run-now job; backfill 400 days on empty provider.
- recurring: cron 00:30 UTC (`RECURRING_SCHEDULER_ENABLED`), `materialize_due`; plus an UNCONDITIONAL run-now boot catch-up job (D5) — a restart materializes today's due occurrences immediately.

## CORS (app.py, gotcha)
- `allow_methods` is a HAND-LISTED verb set — a new HTTP verb served to the browser MUST be added there or every preflight for it gets 400 (bit us live: `PUT /limits` shipped while the list ended at DELETE). Pinned by `tests/test_cors.py::test_preflight_allows_every_verb_the_api_serves`, which derives the verb set from the exported OpenAPI.

## Error envelope
- Domain errors: `HTTPException(detail="STRING_CODE")` — e.g. `CATEGORY_NOT_FOUND`, `CATEGORY_ARCHIVED`, `CATEGORY_NOT_EXPENSE`, `GOAL_NOT_FOUND`, `CONTRIBUTION_EXCEEDS_SAVED`, `RECEIPT_PROCESSING`, `IMAGE_TOO_LARGE`, `LOGIN_BAD_CREDENTIALS`, `REFRESH_TOKEN_INVALID`, `RATE_LIMITED`, `AI_NOT_CONFIGURED`, `STORAGE_UNAVAILABLE`, `TOKEN_INVALID` (401), `TOKEN_ENDPOINT_FORBIDDEN`/`TOKEN_SCOPE_READONLY` (403), `TOKEN_NOT_FOUND`, `ACCOUNT_NOT_FOUND` (404 no-oracle), `ACCOUNT_ARCHIVED`/`ACCOUNT_CURRENCY_MISMATCH`/`ACCOUNT_CURRENCY_IMMUTABLE`/`SAME_ACCOUNT_TRANSFER`/`TRANSFER_FIELDS_REQUIRED`/`COUNTER_FIELDS_WITHOUT_TRANSFER`/`KIND_CHANGE_UNSUPPORTED` (422).
- 422 pattern: routes declare `_UNPROCESSABLE` with raw `anyOf` [DomainError-schema, HTTPValidationError] — honest union without mangling the generated component.
- No-oracle 404s: foreign and missing ids share ONE code path and a byte-identical body; logout always 204; forgot-password never reveals account existence.
