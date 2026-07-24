# Architecture Plan: auth-email-password (roadmap 1.1)

All library claims cite verified-facts.md (F1–F8), fastapi-users 15.0.5 /
fastapi-users-db-sqlalchemy 7.0.0. Anything not covered by F1–F8 is listed in
§13 "Needs verification" — do not treat it as fact.

## Context

Architecture doc promises access JWT (~15 min) + DB-stored revocable refresh
token (~30 days). fastapi-users ships NO refresh endpoint (F1) and its
BearerTransport login response has no refresh_token field (F2). The refresh
mechanism is ours to design. Everything else (register, password hashing,
reset, current-user dependency) the library provides (F1, F3, F7) with known
friction points (F2 form login, F5 table mixins).

## 1. Token lifecycle — the main design question

### Decision D1: how to structure login/refresh/logout

Options considered:

- **A. Custom slim routes reusing library strategy primitives.** Custom
  `POST /auth/login`, `/auth/refresh`, `/auth/logout` that call
  `UserManager.authenticate` (login), `JWTStrategy.write_token` (access),
  `DatabaseStrategy.write_token/read_token/destroy_token` (refresh, F4).
  Stock routers stay for register/reset/users.
- **B. Stock auth router + bolt-on refresh endpoint.** Broken at the root:
  stock login returns `{access_token, token_type}` only (F2) — the client
  never receives a refresh token, so the bolt-on has nothing to bolt onto
  without also customizing login. Rejected.
- **C. Two mounted authentication backends** (JWT + Database), client hits
  both logins or the DB backend's login. Two logins is an absurd client
  contract, and registering the DB backend on the shared Authenticator would
  let opaque refresh tokens authenticate protected routes (F6). Rejected.

**Decision: A.** Smallest custom surface (3 routes), all crypto/storage logic
stays in library primitives, and the F6 guarantee is structural (below).

### Route semantics

- **POST /auth/login** — verifies credentials via `UserManager.authenticate`
  (argon2 via pwdlib default, F3). On success issues BOTH tokens:
  access = `JWTStrategy(secret, lifetime=900)` (F4), refresh =
  `DatabaseStrategy(SQLAlchemyAccessTokenDatabase(session, RefreshToken),
  lifetime=2_592_000)` — opaque `secrets.token_urlsafe()` 43-char value
  stored in our `refresh_tokens` table (F4). Response 200:
  `{"access_token": str, "refresh_token": str, "token_type": "bearer"}`
  (schema `TokenPair`). Failure: 400 `{"detail": "LOGIN_BAD_CREDENTIALS"}` —
  same contract as stock (F2), covers bad password AND inactive user (no
  account-existence oracle).
- **POST /auth/refresh** — JSON body `{"refresh_token": str}`.
  `DatabaseStrategy.read_token` validates existence + max age from
  `created_at` (F4); route additionally rejects `is_active == False` users
  explicitly (do not rely on unverified strategy behavior — §13). Success:
  **rotation** — `destroy_token(old)`, `write_token(user)` new refresh, new
  access JWT; response 200 `TokenPair` (identical shape to login, clients
  handle one shape). Failure (unknown/expired/revoked token, inactive user):
  401 `{"detail": "REFRESH_TOKEN_INVALID"}` — one error, no
  expired-vs-unknown oracle.
- **POST /auth/logout** — JSON body `{"refresh_token": str}`;
  `destroy_token` it. Always 204, even for unknown tokens (no oracle).
  Possession of the refresh token IS the credential — no access-JWT auth
  required, because the common logout moment is "access token already
  expired". The access token stays valid until its ≤15 min expiry — accepted:
  that is the entire point of the short access lifetime; a server-side JWT
  denylist is exactly the complexity the access/refresh split avoids.
  (Stock `/logout` from `get_auth_router` is NOT mounted — with JWTStrategy
  its destroy is a no-op, F1/F4.)

### Rotation & reuse detection (explicit, not buried)

- **Rotation: yes.** Every refresh consumes the old token and issues a new
  one. Cost: one DELETE+INSERT; bounds token lifetime exposure and keeps the
  table at ~1 row per live device session.
- **Reuse detection (token families, revoke-all-on-reuse): OUT of scope.**
  Recommendation: skip. It requires lineage tracking (parent_id / family_id)
  and buys protection against a stolen-and-replayed rotated token — for a
  single-user personal app the added machinery outweighs the threat. Trigger
  to revisit: real second user, or architecture §6's "появятся другие
  пользователи" moment. Concurrent-refresh race (two devices refresh with
  the same token; loser gets 401 and must re-login) is accepted behavior.

### Guarantee: refresh token can never authenticate a protected endpoint

Structural, per F6: the `FastAPIUsers` instance (source of
`current_active_user`) is constructed with ONLY the JWT backend. The
DatabaseStrategy is never registered as an authentication backend on the
Authenticator — it is invoked directly inside the refresh/logout route
bodies. An opaque refresh token presented as `Authorization: Bearer …` fails
JWT decode, period. This must be pinned by a test (qa-checklist item:
refresh token against `GET /users/me` → 401).

### Decision D2: refresh-token transport — JSON body pair vs httpOnly cookie

- **A. JSON body pair for both clients** (architecture doc: "сервер выдаёт
  пару"). One contract for web + mobile, generated TS client consumes it
  directly, no CORS-credentials/CSRF machinery. Cost: web stores the refresh
  token in JS-reachable storage → XSS-exfiltratable.
- **B. httpOnly cookie for web, body pair for mobile.** Better web XSS
  posture, but: two contracts (or content negotiation), CSRF protection on
  /auth/refresh, CORS `credentials: include`, cookie domain config at 1.7 —
  a large hardening surface for a personal app.

**Recommendation: A (body pair).** Matches the architecture doc, both clients
exist, single contract. Record B as the upgrade path if the app ever gets
real users.

## 2. Login request contract

- **A. Keep stock form-encoding** — `application/x-www-form-urlencoded`,
  fields `username` (carries email) + `password`, via
  `OAuth2PasswordRequestForm = Depends()` in our custom route (F2;
  python-multipart is already a hard dep).
- **B. Custom JSON `{email, password}`.**

**Decision: A, form-encoded.** Even though the login route is custom (D1),
form-encoding keeps: (1) the OpenAPI OAuth2 password-flow security scheme
coherent (Swagger "Authorize" works against /auth/login), (2) the stock error
contract (F2), (3) a zero-diff wire contract if we ever revert to stock
router pieces. The generated TS client must send urlencoded for this one
call — see §10.

**Exact wire contract:**

```
POST /auth/login
Content-Type: application/x-www-form-urlencoded
username=<email>&password=<password>

200 → {"access_token": "<jwt>", "refresh_token": "<43-char opaque>", "token_type": "bearer"}
400 → {"detail": "LOGIN_BAD_CREDENTIALS"}
422 → FastAPI validation error (missing fields)
```

## 3. Models: library mixins vs own models

- **A. Library mixins** (`SQLAlchemyBaseUserTable` etc.). Friction, all F5:
  `__tablename__ = "user"` vs architecture's `users`; access-token and OAuth
  mixins hardcode `ForeignKey("user.id")` inside `declared_attr` (breaks the
  moment the table is named `users`); GUID TypeDecorator instead of native
  `sqlalchemy.Uuid`, leaking `fastapi_users_db_sqlalchemy.generics` imports
  into autogenerated migrations; foreign metadata vs our naming-convention
  Base (F8).
- **B. Own models on our Base.** `SQLAlchemyUserDatabase` and
  `SQLAlchemyAccessTokenDatabase` accept ANY model exposing the protocol
  columns (F4, F5) — mixins are optional.

**Decision: B, own models.** The mixins fight four of our conventions at
once; the protocol surface is small and stable. Column types/lengths mirror
the mixins deliberately (F4, F5) so the adapters' assumptions hold.

### Table DDL shapes (exact)

**`users`**

| column | type | constraints |
|---|---|---|
| id | UUID (native `sqlalchemy.Uuid`) | PK, python default `uuid.uuid4` (matches architecture §2 snippet style) |
| email | VARCHAR(320) | NOT NULL, UNIQUE index (mirrors mixin: unique+index, F5) |
| hashed_password | VARCHAR(1024) | NOT NULL (mixin length, F5) |
| is_active | BOOLEAN | NOT NULL, default true |
| is_superuser | BOOLEAN | NOT NULL, default false |
| is_verified | BOOLEAN | NOT NULL, default false |
| created_at | TIMESTAMPTZ | NOT NULL, server_default now() (ours; mixin lacks it, cheap and useful) |

`is_superuser` / `is_verified` are kept as columns (protocol columns the
library reads) even though no flow sets them in 1.1.

**`refresh_tokens`** (role-named; NOT the mixin's `accesstoken`, F5)

| column | type | constraints |
|---|---|---|
| token | VARCHAR(43) | PK (`token_urlsafe` output length, F4) |
| user_id | UUID | NOT NULL, FK → users.id ON DELETE CASCADE, index |
| created_at | TIMESTAMPTZ | NOT NULL — MUST be tz-aware; DatabaseStrategy computes max age from it (F4) |

Tokens stored plaintext (that is what DatabaseStrategy does, F4). Hashing at
rest was considered and rejected: requires a custom strategy, and DB
compromise of a single-user app is game-over anyway. Recorded, not buried.

**`oauth_accounts`** — deferred, see §4.

## 4. Table set for migration 0001

- **`users` + `refresh_tokens`: yes.** Required by the task.
- **`oauth_accounts`: create now vs defer to 5.1.** Architecture doc implies
  now ("схема базы уже это учитывает"). Real tradeoff: creating now means
  freezing column shapes copied from a library mixin whose exact columns are
  NOT in verified facts (F5 covers only tablename + FK), against a
  fastapi-users version that may have moved by stage 5 — a table that sits
  empty for four stages and may need altering anyway. Deferring costs one
  trivial additive migration at 5.1. The "задел" the architecture actually
  needs — same user PK, accounts merged by email — is preserved by design,
  not by an empty table. **Recommendation: defer to 5.1.** (PM question, since
  it contradicts a doc sentence.)
- **`profiles`: here vs 1.2.** PLAN.md 1.2 explicitly owns
  "users, profiles, categories, transactions" migrations. Nothing in 1.1
  reads base_currency. **Recommendation: defer to 1.2.** Consequence decided
  now: `on_after_register` (F7) is a log-only no-op in 1.1; 1.2 adds profile
  creation in the hook AND backfills profiles for pre-existing users in its
  migration. This must be written into 1.2's task notes.

So migration 0001 = `users` + `refresh_tokens`, autogenerated against our
naming convention (F8: convention already on Base.metadata, zero prior
tables — churn-free).

## 5. Endpoint inventory + mounted routers

Prefix everything auth under `/auth`, users under `/users`.

| Method+Path | Source | Auth | Success | Errors | Request → Response |
|---|---|---|---|---|---|
| POST /auth/register | stock `get_register_router` (F1) | none | 201 | 400 `REGISTER_USER_ALREADY_EXISTS` / `REGISTER_INVALID_PASSWORD`, 422 | `UserCreate {email, password}` → `UserRead` |
| POST /auth/login | custom (D1/D2) | none | 200 | 400 `LOGIN_BAD_CREDENTIALS`, 422, 429 | urlencoded `username,password` → `TokenPair` |
| POST /auth/refresh | custom | refresh token in body | 200 | 401 `REFRESH_TOKEN_INVALID`, 422 | `{refresh_token}` → `TokenPair` |
| POST /auth/logout | custom | refresh token in body | 204 | 422 only | `{refresh_token}` → empty |
| POST /auth/forgot-password | stock `get_reset_password_router` (F1) | none | 202 always | 422, 429 | `{email}` → empty |
| POST /auth/reset-password | same router | none | 200 | 400 `RESET_PASSWORD_BAD_TOKEN`, 422 | `{token, password}` → empty |
| GET /users/me | stock `get_users_router` (F1) | access JWT | 200 | 401 | → `UserRead` |
| PATCH /users/me | same | access JWT | 200 | 400/401/422 | `UserUpdate` → `UserRead` |
| GET/PATCH/DELETE /users/{id} | same | access JWT + superuser (gating NOT in facts — §13) | 200/204 | 401/403/404 | per stock |

Router mount decisions (each explicit):

- **Reset-password router: MOUNT.** F7: `on_after_forgot_password` receives
  the raw reset token and there is no email infra. Delivery story for a
  personal app: the hook logs the token server-side at WARNING; the operator
  (the only user) reads it from logs and calls /auth/reset-password.
  Alternative — skip until email infra exists — leaves the deployed app with
  NO password recovery. Recommendation: mount with log delivery; revisit at
  "other users" trigger. /auth/forgot-password returns 202 for unknown emails
  too (stock behavior — no account oracle; verify at implementation).
- **Verify router: SKIP.** Nothing consumes `is_verified`; the dependency is
  `current_active_user`, not verified (F6). Architecture §6 defers email
  confirmation. Mounting dead endpoints pollutes the generated client.
- **Users router: MOUNT FULL STOCK.** 1.5 needs GET /users/me; PATCH /me is
  free and useful (password change). The /{id} routes are believed
  superuser-gated but that is NOT in F1 — implementation-time verification
  gate: if they are not superuser-gated, fall back to custom /me-only routes.
  With no superuser existing in 1.1, gated /{id} routes are dead-but-harmless.

### Response-shape decisions (Phase 3.5 point 4 — not inherited)

- **`UserRead` = `{id: UUID, email: str, is_active: bool}`.** Lean, own
  Pydantic schema. `is_superuser` and `is_verified` are deliberately NOT
  exposed — unused by any client flow, pure noise in the TS types. (Stock
  BaseUser exposes them; we subclass/redefine.)
- **`UserUpdate` = `{email?: str, password?: str}` ONLY.** Defining our own
  schema without `is_active/is_superuser/is_verified` makes
  privilege-escalation-via-PATCH structurally impossible regardless of
  whether the library's safe-update behavior holds (not in facts — §13).
- **`TokenPair` = `{access_token, refresh_token, token_type: "bearer"}`** —
  the single shape for login AND refresh.
- Register returns `UserRead` (id+email+is_active), NOT tokens — client logs
  in after registering. Keeps register stock; one flow for token issuance.

## 6. Index / perf / hygiene verdicts (every new query pattern)

| Query pattern | Verdict |
|---|---|
| login: user by email | covered by the UNIQUE index on `users.email`. Case-sensitivity of the adapter's lookup is a §13 item; if it lowercases, the plain unique index still serves at personal scale — a `lower(email)` functional index is the trigger-documented upgrade. |
| JWT auth: user by id (per protected request) | PK lookup. Covered. |
| refresh/logout: token by value | PK on `refresh_tokens.token`. Covered. |
| purge: `created_at < now() - 30d` | **No index on `created_at` — deliberate.** Rotation + logout keep the table at ~1 row per live device; expired strays from abandoned sessions accrue at personal-app scale (single digits/month). Seq scan is correct here. |
| expired-token purge job | **Defer to 3.1** (APScheduler arrives there; a daily `DELETE WHERE created_at < now() - lifetime` is a one-liner then). Alternative — opportunistic delete on each login — rejected as invisible magic. Until 3.1, expired rows are inert: `read_token` enforces max age (F4), so they can never authenticate. Record in 3.1's scope. |
| user delete cascade | `refresh_tokens.user_id` ON DELETE CASCADE — deleting a user revokes all sessions atomically. (Future tables decide their own ondelete at 1.2; oauth_accounts gets CASCADE at 5.1.) |

## 7. Rate limiting

- **A. Add slowapi now** on the unauthenticated credential endpoints:
  /auth/login (e.g. 10/min/IP), /auth/register (5/hour/IP),
  /auth/forgot-password (5/hour/IP). 429 on breach.
- **B. Defer to 1.7 (deploy).** API only faces the internet at 1.7.

**Recommendation: A, now.** Brute-force on /auth/login is real (task text),
scope is small, and 1.7 is a deploy task that should not grow app-code scope.
Caveats stated: slowapi's default storage is in-memory per-process — fine for
the single-container deploy planned in 1.7, resets on restart, NOT multi-
worker-safe; trigger to move to Redis storage = second worker/instance.
slowapi's exact current API is entirely unverified (no F-fact) — backend-
engineer must verify at planning (§13). Tests: limiter must be disabled or
given no-op storage in the test app factory path; QA needs one positive 429
test with a tight limit. Argon2 (F3) already makes per-attempt cost high —
rate limiting is the second layer, not the only one.

## 8. Settings & secrets

New `Settings` fields (F8: only `database_url` exists today):

- `jwt_secret: str` — required, no default (fail fast on missing env).
  Used for the access JWTStrategy; also reused as the reset-password token
  secret (single-secret simplicity for a personal app; separate
  `reset_password_token_secret` field is the documented upgrade). Exact
  UserManager attribute names for reset secrets: §13.
- `access_token_lifetime_seconds: int = 900` (~15 min, F4).
- `refresh_token_lifetime_seconds: int = 2_592_000` (30 days).

`.env.example` gains `JWT_SECRET=` with a generate-me comment
(`python -c "import secrets; print(secrets.token_urlsafe(32))"`). Lifetimes
keep code defaults — not surfaced in .env.example (avoid speculative knobs);
they exist as fields because tests legitimately shrink them.

**DI decision:** auth dependencies must NOT call `get_settings()` at module
level (breaks the F8 test pattern of constructing Settings explicitly).
`create_app` already resolves settings — it additionally stores
`app.state.settings = resolved`; strategy/manager dependency factories read
settings from `request.app.state`, same pattern as `get_session` (db.py).

## 9. Module layout

Preserve the five-layer split (architecture §4); no new `auth/` package.

- `models/user.py` → `User`; `models/refresh_token.py` → `RefreshToken`;
  both re-exported from `models/__init__.py` (Alembic autogen sees them, F8).
- `schemas/user.py` → `UserRead`, `UserCreate`, `UserUpdate`.
- `schemas/auth.py` → `TokenPair`, `RefreshRequest`, `LogoutRequest`.
- `budget_api/auth.py` (top-level module, sibling of `db.py`) — the wiring:
  `get_user_db`, `UserManager` (+ F7 hooks: `on_after_register` no-op log,
  `on_after_forgot_password` token log), strategy factories, JWT auth
  backend, `FastAPIUsers` instance (JWT backend ONLY — F6), and the canonical
  **`current_active_user`** dependency. Rationale: this is framework glue /
  infrastructure like `db.py`, not a `services/` integration (services/ is
  Claude/rates/storage per §4). **Every later task imports
  `from budget_api.auth import current_active_user` — single definition
  point (architecture §3).**
- `routers/auth.py` — includes stock register + reset routers, defines custom
  login/refresh/logout. `routers/users.py` — stock users router.
- Dependency direction holds: routers → auth.py/services → models/db/config.
  `auth.py` imports models, db, config; routers import auth.py; nothing
  imports routers.

## 10. Contract regeneration impact

`pnpm openapi` + `pnpm --filter @budget/api-client generate`; BOTH
`apps/api/openapi.json` and `packages/api-client/src/schema.d.ts` committed
together or drift gates go red (F8, carry-forward). Client-facing surprises
to document in the task handoff for 1.5's engineer:

- /auth/login requestBody is `application/x-www-form-urlencoded` — the only
  non-JSON call in the API; openapi-fetch needs a urlencoded `bodySerializer`
  for this one path. FastAPI will emit an auto-named form schema (e.g.
  `Body_auth_login_…`) — ugly but harmless; do not fight it.
- New `securitySchemes` (OAuth2 password flow pointing at /auth/login) and
  per-route `security` on protected endpoints.
- fastapi-users error models put string codes in `detail`
  (`LOGIN_BAD_CREDENTIALS` etc., F2) and its ErrorModel `detail` is
  string-or-object — the TS side sees a union.
- 429 responses (slowapi) may not appear in the schema unless declared —
  declare them on the limited routes so the client types are honest.
- frontend-engineer sanity-REVIEWS the generated auth surface (per task.md);
  no client code changes in 1.1.

## 11. Open questions for PM (each either/or, with recommendation)

1. `oauth_accounts` table: create empty now (as architecture doc implies) vs
   defer to 5.1 → **defer to 5.1** (§4; contradicts one doc sentence, hence
   PM sign-off).
2. `profiles`: create here vs at 1.2 → **1.2** (§4; 1.2 must backfill +
   extend on_after_register — carry into 1.2's task).
3. Login wire format: stock form-encoded vs custom JSON → **form-encoded**
   (§2).
4. Refresh-token transport: JSON body pair for both clients vs httpOnly
   cookie for web → **body pair** (§1 D2).
5. Refresh reuse-detection (token families): in scope vs out → **out**;
   rotation only (§1).
6. Rate limiting: slowapi now on login/register/forgot-password vs defer to
   1.7 → **now** (§7).
7. Reset-password router: mount with log-based token delivery vs skip until
   email infra → **mount** (§5).
8. Verify router: mount vs skip → **skip** (§5).
9. Users router: full stock vs custom /me-only → **full stock**, conditional
   on verifying /{id} superuser gating (§5, §13).
10. Expired refresh-token purge: opportunistic now vs APScheduler job at 3.1
    → **defer to 3.1** (§6).

## 12. Decisions made (not requiring PM input)

- Custom slim login/refresh/logout reusing JWTStrategy + DatabaseStrategy
  primitives (F4); stock routers for register/reset/users (F1).
- FastAPIUsers/Authenticator constructed with the JWT backend ONLY — refresh
  tokens structurally cannot authenticate protected routes (F6); pinned by
  test.
- Refresh rotation on every use; logout = revoke-by-possession, 204 always;
  single `TokenPair` response shape; 400 `LOGIN_BAD_CREDENTIALS` /
  401 `REFRESH_TOKEN_INVALID` error contract, no oracles.
- Own SQLAlchemy models on our Base (naming convention, `users` /
  `refresh_tokens`, native Uuid) — no library mixins (F5 friction); adapters
  accept them (F4, F5).
- Migration 0001 = `users` + `refresh_tokens` only.
- Lean `UserRead {id, email, is_active}`; own `UserUpdate {email?, password?}`
  — escalation fields structurally absent.
- Password hashing: library default pwdlib argon2 — zero config (F3).
- `on_after_register` = log-only no-op in 1.1 (F7).
- Settings: `jwt_secret` (required), lifetime fields with code defaults;
  settings on `app.state`, no module-level `get_settings()` in auth deps.
- Module layout: `budget_api/auth.py` glue module owning
  `current_active_user`; models/schemas/routers per five-layer split.
- No `created_at` index on `refresh_tokens`; no email functional index —
  both recorded with triggers (§6).

## 13. Needs verification (backend-engineer, at planning, against installed packages)

Not covered by F1–F8 — verify before coding, per Phase 3.6:

1. `SQLAlchemyUserDatabase.get_by_email` case handling (lowercased lookup or
   exact?) and any email normalization in UserManager — affects whether the
   plain unique index on `email` needs a `lower(email)` variant and whether
   `Foo@x.com` / `foo@x.com` can both register.
2. `get_users_router` /{id} routes: confirm superuser gating and available
   constructor flags — decides full-mount vs /me-only fallback (§5, Q9).
3. `UserManager` attributes required when mounting the reset router
   (`reset_password_token_secret`, token lifetime knob) and whether
   /auth/forgot-password returns 202 for unknown emails (assumed stock).
4. Exact signatures/return types of `DatabaseStrategy.write_token /
   read_token / destroy_token` and what `read_token` returns for an inactive
   user (route re-checks `is_active` regardless).
5. Whether the stock register router's response can be our lean `UserRead`
   via the schema generics (assumed yes — fastapi-users takes schema types as
   parameters) and that stock `safe=True` registration ignores
   is_superuser/is_verified input.
6. slowapi: current version, limiter API, FastAPI integration pattern,
   test-mode disable — NOTHING about slowapi is in verified facts (§7).
7. Exact exception types raised by strategy/manager on invalid credentials/
   tokens (for precise error handling in custom routes).
8. Test-DB table story (run `alembic upgrade head` against budget_test in a
   session fixture + per-test cleanup vs create_all) — plan-level choice for
   backend-engineer; F8 notes no setup exists yet.

## 14. What this does NOT decide

- Test fixture mechanics (migration-vs-create_all, truncation strategy) —
  backend-engineer's plan.md (with §13.8 verified).
- Exact slowapi wiring and limits tuning (§7 numbers are starting points).
- Log format/redaction details for the reset-token delivery log line.
- 1.2 concerns: profiles shape, backfill mechanics, on_after_register
  extension — only the obligation is recorded here.
- Anything client-side (1.5/1.8 own token storage, refresh scheduling,
  401-retry logic).
