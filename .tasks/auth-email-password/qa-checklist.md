# QA Checklist: auth-email-password (roadmap 1.1)

## Scope

Live-server + command-level verification for email+password auth. This checklist
proves the things pytest **cannot** prove on its own:

- the real HTTP wire contract against a running uvicorn (form-encoded login, JSON
  refresh/logout, JWT-protected `/users/me`), including the full stateful journey
  (register → login → refresh rotation → logout → revoked-refresh);
- security contracts that are only meaningful over a real roundtrip (refresh-token-
  as-Bearer rejection, the no-oracle error bodies, privilege fields absent from the
  wire, is_superuser not settable);
- the reset-password flow, which is **live-only** because the reset token is
  delivered via a server WARNING log, not email (F7 / architecture §5);
- rate-limiting behaviour end-to-end, including the **fragile post-decorated
  stock-route** register-429 mechanism (AM-D one-time proof);
- the migration lifecycle (upgrade/downgrade/upgrade, naming convention, FK CASCADE)
  against a real Postgres;
- the committed contract artifacts (`openapi.json`, `schema.d.ts`) and Swagger UI.

**Out of scope here** (owned by backend pytest — see plan.md "Test plan", listed in
the Coverage note at the bottom, NOT duplicated): business-logic branches, inactive-
user re-check, expired-token max-age math, case-insensitive dedup, unit-level rotation
assertions. This checklist covers the AMENDED plan state: **AM-A** (`UserUpdate` is a
lean `{email?, password?}` — privilege fields absent from the PATCH schema),
**AM-D** (backend adds a register-429 pytest; the register-429 curl below is the
one-time end-to-end proof, not the CI gate), **AM-E** (password reset/change revokes
all refresh tokens — live check TC-C5), **AM-H** (`UserUpdate` extras ignored → 200,
not 422-forbid — TC-B7), **AM-I** (429 body normalized to `{"detail":"RATE_LIMITED"}`,
one envelope API-wide — TC-D1/TC-D3), and **AM-J** (`email` unique+index emits a single
UNIQUE INDEX `ix_users_email`, no `uq_users_email` constraint — TC-E2).

---

## Preconditions

**Two distinct databases — do not confuse them:**

| Consumer | DB | Port (this machine) | Committed default |
|---|---|---|---|
| Live server (these curl checks) | `budget` | **5443** | 5433 |
| pytest (Section A) | `budget_test` | **5443** | 5433 |

- Local Postgres is on port **5443** here (via `TEST_DATABASE_URL`); the committed
  compose/`.env` default is `5433`. The curl checks target the **live server**, which
  runs against the `budget` DB. Set `PGURL` (below) to the port your live server uses.
- **⚠ Machine-specific safety fact (senior-lead verified live):** this project's local
  Postgres is container **`budget-postgres-1` on port `5443`** (databases `budget` +
  `budget_test`) — this is the ONLY container QA touches, and only via `psql`/the app,
  never `docker stop/start`. **Port `5433` on this machine belongs to a FOREIGN
  project's container (`ms-menu-v2-postgres-test-1`) — never connect to it and never
  stop/start any container.** `PGURL` stays **5443**. The committed `5433` default is a
  repo constant, NOT this machine's port.
- **Live server must be started with `JWT_SECRET` set** and `DATABASE_URL` pointing at
  the `budget` DB. `create_app` needs `Settings`; started via
  `pnpm --filter @budget/api dev` (uvicorn `--factory`) or equivalent with those env
  vars present. If `JWT_SECRET` is missing the app must fail fast (§8) — a server that
  started at all implies the secret is set.
- Migration 0001 must be applied to the `budget` DB (`uv run alembic upgrade head`)
  before the journey checks — Area E exercises the migration lifecycle explicitly.
- `rate_limit_enabled` must be **True** on the live server (default) for Area D; note
  slowapi storage is in-memory per-process and **resets on server restart**, and all
  localhost curls share one client IP — see the order-dependency note under Area D.

**Shell setup for Section B (run once):**

```bash
BASE=http://localhost:8000
PGURL="postgresql://budget:budget@localhost:5443/budget"   # live-server DB
EMAIL="qa+$(date +%s)@example.com"                          # unique per run
PW="Str0ng-Passw0rd!"
NEWPW="Rot4ted-Passw0rd!"
CT_JSON='Content-Type: application/json'
CT_FORM='Content-Type: application/x-www-form-urlencoded'
```

---

## Section A: Pytest test cases

*Owned by backend-engineer. Enumerated in `plan.md` "Test plan" (`tests/test_auth.py`,
`tests/test_users.py`). QA does NOT re-list them here; QA verifies them by running
`uv run pytest` (the `make test` equivalent — no Makefile, per plan) and confirming
all green during /test. If any pytest fails, escalate to senior-lead — do not fix
backend code.* See the Coverage note for what is deliberately left to pytest.

---

## Section B: Curl + command test cases
*Owned by qa-engineer. Run against the live server / repo during /test.*

### Area A — Full auth user journey (chained; run in order)

#### TC-A1: Register returns lean user, privilege fields absent
- **Method/Endpoint**: POST `/auth/register`
- **Auth**: none
- **Expected**: `201`; body has exactly `id`, `email`, `is_active:true`; body does
  **NOT** contain `is_superuser` or `is_verified` or `hashed_password`.
- **curl**:
```bash
curl -s -w '\n%{http_code}\n' -X POST "$BASE/auth/register" \
  -H "$CT_JSON" -d "{\"email\":\"$EMAIL\",\"password\":\"$PW\"}"
```
- **Actual**: `201`; body `{"id":"171ac84c-...","email":"qa+...@example.com","is_active":true}` — no `is_superuser`/`is_verified`/`hashed_password`.
- **Status**: ✅ pass

#### TC-A2: Login is form-encoded, returns TokenPair
- **Method/Endpoint**: POST `/auth/login`
- **Setup**: TC-A1 passed.
- **Expected**: `200`; body `{access_token, refresh_token, token_type:"bearer"}`;
  `refresh_token` is a 43-char opaque string; `access_token` is a JWT (3 dot-parts).
  Content-Type of request MUST be `application/x-www-form-urlencoded` with
  `username`=email.
- **curl**:
```bash
RESP=$(curl -s -X POST "$BASE/auth/login" -H "$CT_FORM" \
  --data-urlencode "username=$EMAIL" --data-urlencode "password=$PW")
echo "$RESP"
ACCESS=$(echo "$RESP" | jq -r .access_token)
REFRESH=$(echo "$RESP" | jq -r .refresh_token)
echo "refresh_len=${#REFRESH}"   # expect 43
```
- **Actual**: `200`; `{access_token, refresh_token, token_type:"bearer"}`; `refresh_len=43`; `access_token` has 3 dot-parts (JWT). Request sent as `application/x-www-form-urlencoded` with `username`=email.
- **Status**: ✅ pass

#### TC-A3: GET /users/me with access JWT returns lean user
- **Method/Endpoint**: GET `/users/me`
- **Setup**: TC-A2 (`$ACCESS`).
- **Expected**: `200`; body `{id, email, is_active}` only; no `is_superuser`/
  `is_verified`.
- **curl**:
```bash
curl -s -w '\n%{http_code}\n' "$BASE/users/me" \
  -H "Authorization: Bearer $ACCESS"
```
- **Actual**: `200`; body `{"id":"171ac84c-...","email":"qa+...","is_active":true}` only — no `is_superuser`/`is_verified`.
- **Status**: ✅ pass

#### TC-A4: Refresh rotates — new pair differs from old
- **Method/Endpoint**: POST `/auth/refresh`
- **Setup**: TC-A2 (`$REFRESH`).
- **Expected**: `200`; new `TokenPair`; `new_refresh != $REFRESH` and
  `new_access != $ACCESS`.
- **curl**:
```bash
RESP2=$(curl -s -X POST "$BASE/auth/refresh" -H "$CT_JSON" \
  -d "{\"refresh_token\":\"$REFRESH\"}")
echo "$RESP2"
NEW_REFRESH=$(echo "$RESP2" | jq -r .refresh_token)
[ "$NEW_REFRESH" != "$REFRESH" ] && echo "ROTATED"
```
- **Actual**: `200`; new `TokenPair`; `new_refresh != $REFRESH` (**ROTATED** confirmed). **However** `new_access` was byte-identical to `$ACCESS`: the access JWT encodes only `sub`/`aud`/`exp` and `exp` has 1-second granularity, so a refresh issued in the same wall-clock second yields an identical JWT string. Independently re-verified with a fresh login + 1.3s delay + refresh: `ACCESS_DIFFERS_ACROSS_SECOND_BOUNDARY` — the access token IS re-minted each refresh. The refresh-rotation contract holds; the `new_access != $ACCESS` sub-assertion is a same-second QA-timing artifact, not a product defect.
- **Status**: ⚠ rotation contract verified; access-string-equality is a same-second timing artifact (see note)

#### TC-A5: Old refresh token rejected after rotation (reuse → 401)
- **Method/Endpoint**: POST `/auth/refresh`
- **Setup**: TC-A4 consumed `$REFRESH`.
- **Expected**: `401`; body `{"detail":"REFRESH_TOKEN_INVALID"}`.
- **curl**:
```bash
curl -s -w '\n%{http_code}\n' -X POST "$BASE/auth/refresh" -H "$CT_JSON" \
  -d "{\"refresh_token\":\"$REFRESH\"}"
```
- **Actual**: `401`; body `{"detail":"REFRESH_TOKEN_INVALID"}` — rotated-token reuse rejected.
- **Status**: ✅ pass

#### TC-A6: Logout revokes current refresh token (204, no oracle)
- **Method/Endpoint**: POST `/auth/logout`
- **Setup**: TC-A4 (`$NEW_REFRESH`).
- **Expected**: `204`, empty body. No access JWT required (possession-of-refresh IS
  the credential, architecture §1).
- **curl**:
```bash
curl -s -w '\n%{http_code}\n' -X POST "$BASE/auth/logout" -H "$CT_JSON" \
  -d "{\"refresh_token\":\"$NEW_REFRESH\"}"
```
- **Actual**: `204`, empty body. No access JWT was required.
- **Status**: ✅ pass

#### TC-A7: Refresh with revoked (logged-out) token → 401
- **Method/Endpoint**: POST `/auth/refresh`
- **Setup**: TC-A6 revoked `$NEW_REFRESH`.
- **Expected**: `401`; `{"detail":"REFRESH_TOKEN_INVALID"}`.
- **curl**:
```bash
curl -s -w '\n%{http_code}\n' -X POST "$BASE/auth/refresh" -H "$CT_JSON" \
  -d "{\"refresh_token\":\"$NEW_REFRESH\"}"
```
- **Actual**: `401`; body `{"detail":"REFRESH_TOKEN_INVALID"}` — revoked (logged-out) token rejected.
- **Status**: ✅ pass

---

### Area B — Security-critical negative checks

#### TC-B1: Refresh token as Bearer cannot authenticate a protected route (F6)
- **Method/Endpoint**: GET `/users/me`
- **Setup**: obtain a fresh login pair first (Area A exhausted its tokens); grab a
  `refresh_token` and send it as the Bearer credential.
- **Expected**: `401`. The opaque refresh token fails JWT decode — structural
  guarantee (JWT backend only on the Authenticator, F6/plan Risks).
- **curl**:
```bash
R=$(curl -s -X POST "$BASE/auth/login" -H "$CT_FORM" \
  --data-urlencode "username=$EMAIL" --data-urlencode "password=$PW")
RT=$(echo "$R" | jq -r .refresh_token)
curl -s -w '\n%{http_code}\n' "$BASE/users/me" -H "Authorization: Bearer $RT"
```
- **Actual**: `401`; body `{"detail":"Unauthorized"}` — opaque refresh token fails JWT decode when presented as Bearer.
- **Status**: ✅ pass

#### TC-B2: Login bad password → 400 (no oracle)
- **Method/Endpoint**: POST `/auth/login`
- **Expected**: `400`; `{"detail":"LOGIN_BAD_CREDENTIALS"}`.
- **curl**:
```bash
curl -s -w '\n%{http_code}\n' -X POST "$BASE/auth/login" -H "$CT_FORM" \
  --data-urlencode "username=$EMAIL" --data-urlencode "password=wrong"
```
- **Actual**: `400`; body `{"detail":"LOGIN_BAD_CREDENTIALS"}`.
- **Status**: ✅ pass

#### TC-B3: Login nonexistent user → identical 400 body (no account-existence oracle)
- **Method/Endpoint**: POST `/auth/login`
- **Setup**: compare byte-for-byte against TC-B2's body.
- **Expected**: `400`; `{"detail":"LOGIN_BAD_CREDENTIALS"}` — **exactly** the same
  status and body as TC-B2 (bad password vs nonexistent user indistinguishable).
- **curl**:
```bash
curl -s -w '\n%{http_code}\n' -X POST "$BASE/auth/login" -H "$CT_FORM" \
  --data-urlencode "username=nobody-$(date +%s)@example.com" \
  --data-urlencode "password=whatever"
```
- **Actual**: `400`; body `{"detail":"LOGIN_BAD_CREDENTIALS"}` — **byte-identical** status+body to TC-B2. No account-existence oracle.
- **Status**: ✅ pass

#### TC-B4: forgot-password for unknown email → 202 (no oracle)
- **Method/Endpoint**: POST `/auth/forgot-password`
- **Expected**: `202`, empty body, even for an email that has no account.
- **curl**:
```bash
curl -s -w '\n%{http_code}\n' -X POST "$BASE/auth/forgot-password" -H "$CT_JSON" \
  -d "{\"email\":\"ghost-$(date +%s)@example.com\"}"
```
- **Actual**: `202`; body is JSON `null`. Same status as the real-user case (TC-C1) — no account-existence oracle; `null` body carries no leak.
- **Status**: ✅ pass (body is JSON `null`, not strictly empty — noted, no info leak)

#### TC-B5: logout with unknown/garbage token → 204 (no oracle)
- **Method/Endpoint**: POST `/auth/logout`
- **Expected**: `204`, empty body (no 404 that would confirm token existence).
- **curl**:
```bash
curl -s -w '\n%{http_code}\n' -X POST "$BASE/auth/logout" -H "$CT_JSON" \
  -d '{"refresh_token":"this-is-not-a-real-token"}'
```
- **Actual**: `204`, empty body — no 404 that would confirm token existence.
- **Status**: ✅ pass

#### TC-B6: is_superuser not settable via register (accepted, ignored, unchanged)
- **Method/Endpoint**: POST `/auth/register` with `is_superuser:true` in the body
- **Expected**: `201`; response body has no `is_superuser`; **DB row
  `is_superuser = false`** (safe-register drops privilege fields, §13.5).
- **curl**:
```bash
ESC="esc+$(date +%s)@example.com"
curl -s -w '\n%{http_code}\n' -X POST "$BASE/auth/register" -H "$CT_JSON" \
  -d "{\"email\":\"$ESC\",\"password\":\"$PW\",\"is_superuser\":true,\"is_verified\":true}"
psql "$PGURL" -tAc \
  "SELECT is_superuser, is_verified FROM users WHERE email='$ESC';"   # expect: f|f
```
- **Actual**: `201`; response body lean (no `is_superuser`); DB row `is_superuser|is_verified = f|f`. Privilege fields dropped by safe-register.
- **Status**: ✅ pass

#### TC-B7: is_superuser not settable via PATCH /users/me (AM-A; accepted, unchanged)
- **Method/Endpoint**: PATCH `/users/me` with `is_superuser:true`
- **Setup**: login as the `$ESC` user from TC-B6 to get an access JWT.
- **Expected**: `200` — the lean `UserUpdate {email?, password?}` schema (AM-A) does
  not declare `is_superuser`; Pydantic **ignores** the extra field (default
  `extra="ignore"`), so the request is accepted and the field is unchanged. Response
  body still lean (no `is_superuser`); **DB row `is_superuser` stays `false`**.
- **curl**:
```bash
EA=$(curl -s -X POST "$BASE/auth/login" -H "$CT_FORM" \
  --data-urlencode "username=$ESC" --data-urlencode "password=$PW" | jq -r .access_token)
curl -s -w '\n%{http_code}\n' -X PATCH "$BASE/users/me" \
  -H "Authorization: Bearer $EA" -H "$CT_JSON" -d '{"is_superuser":true}'
psql "$PGURL" -tAc "SELECT is_superuser FROM users WHERE email='$ESC';"  # expect: f
```
- **Actual**: `200`; response body lean; DB row `is_superuser` stays `f`. Lean `UserUpdate {email?, password?}` (AM-A) ignores the extra `is_superuser` field (`extra="ignore"`).
- **Status**: ✅ pass

#### TC-B8: Regular user cannot reach superuser-gated /users/{id} → 403
- **Method/Endpoint**: GET `/users/{id}` with a non-superuser access JWT
- **Setup**: any valid access token (`$ACCESS` from a fresh login) + any UUID.
- **Expected**: `403` (the `/{id}` routes carry `Depends(get_current_superuser)`,
  §13.2; an authenticated non-superuser is forbidden — distinct from 401).
- **curl**:
```bash
AT=$(curl -s -X POST "$BASE/auth/login" -H "$CT_FORM" \
  --data-urlencode "username=$EMAIL" --data-urlencode "password=$PW" | jq -r .access_token)
curl -s -w '\n%{http_code}\n' "$BASE/users/00000000-0000-0000-0000-000000000000" \
  -H "Authorization: Bearer $AT"
```
- **Actual**: `403`; body `{"detail":"Forbidden"}` — authenticated non-superuser forbidden on `/users/{id}` (distinct from 401).
- **Status**: ✅ pass

---

### Area C — Reset-password flow end-to-end (live-only; token via server log)

> The reset token is delivered by `on_after_forgot_password` logging at WARNING
> (F7 / architecture §5). This flow **cannot** be exercised by pytest as a real
> roundtrip because there is no email infra — QA reads the token from the live
> server's stdout/log. Run these with access to the server log stream.
> TC-C5 additionally verifies that the reset **revokes all refresh tokens** (AM-E/R1):
> a refresh token captured BEFORE the reset must be dead afterward.

#### TC-C1: forgot-password for a real user → 202, token appears in log
- **Method/Endpoint**: POST `/auth/forgot-password`
- **Setup**: use `$EMAIL` (registered in TC-A1). First log in and save a **pre-reset**
  refresh token (`$PRE_RESET_REFRESH`) — TC-C5 asserts it dies after the reset.
- **Expected**: `202`; a WARNING log line on the server containing the reset token.
- **curl**:
```bash
# capture a refresh token that exists BEFORE the reset (for TC-C5):
PRE_RESET_REFRESH=$(curl -s -X POST "$BASE/auth/login" -H "$CT_FORM" \
  --data-urlencode "username=$EMAIL" --data-urlencode "password=$PW" | jq -r .refresh_token)
echo "pre_reset_refresh=$PRE_RESET_REFRESH"
curl -s -w '\n%{http_code}\n' -X POST "$BASE/auth/forgot-password" -H "$CT_JSON" \
  -d "{\"email\":\"$EMAIL\"}"
# then read the server log; capture the token:
# RESET_TOKEN=<token from the WARNING line>
```
- **Actual**: `202`. Server WARNING log line captured: `password reset token for 171ac84c-fe40-45bf-b212-54f3494cd631: eyJhbGci...RR8` (357-char JWT reset token). `pre_reset_refresh` captured before the reset for TC-C5.
- **Status**: ✅ pass

#### TC-C2: reset-password with the logged token → 200
- **Method/Endpoint**: POST `/auth/reset-password`
- **Setup**: `RESET_TOKEN` from TC-C1.
- **Expected**: `200`, empty body.
- **curl**:
```bash
curl -s -w '\n%{http_code}\n' -X POST "$BASE/auth/reset-password" -H "$CT_JSON" \
  -d "{\"token\":\"$RESET_TOKEN\",\"password\":\"$NEWPW\"}"
```
- **Actual**: `200` (body JSON `null`).
- **Status**: ✅ pass

#### TC-C3: old password no longer works → 400
- **Method/Endpoint**: POST `/auth/login`
- **Expected**: `400`; `{"detail":"LOGIN_BAD_CREDENTIALS"}`.
- **curl**:
```bash
curl -s -w '\n%{http_code}\n' -X POST "$BASE/auth/login" -H "$CT_FORM" \
  --data-urlencode "username=$EMAIL" --data-urlencode "password=$PW"
```
- **Actual**: `400`; body `{"detail":"LOGIN_BAD_CREDENTIALS"}` — old password no longer works.
- **Status**: ✅ pass

#### TC-C4: new password logs in → 200
- **Method/Endpoint**: POST `/auth/login`
- **Expected**: `200`; valid `TokenPair`.
- **curl**:
```bash
curl -s -w '\n%{http_code}\n' -X POST "$BASE/auth/login" -H "$CT_FORM" \
  --data-urlencode "username=$EMAIL" --data-urlencode "password=$NEWPW"
```
- **Actual**: `200`; valid `TokenPair` returned with the new password.
- **Status**: ✅ pass

#### TC-C5: refresh tokens revoked by password reset → 401 (AM-E/R1)
- **Method/Endpoint**: POST `/auth/refresh`
- **Setup**: `$PRE_RESET_REFRESH` captured in TC-C1 (obtained **before** TC-C2's
  successful reset). The reset must revoke all of the user's refresh tokens.
- **Expected**: `401`; body `{"detail":"REFRESH_TOKEN_INVALID"}` — the pre-reset token
  is dead because `on_after_reset_password` deleted the user's `refresh_tokens` rows.
- **curl**:
```bash
curl -s -w '\n%{http_code}\n' -X POST "$BASE/auth/refresh" -H "$CT_JSON" \
  -d "{\"refresh_token\":\"$PRE_RESET_REFRESH\"}"
```
- **Actual**: `401`; body `{"detail":"REFRESH_TOKEN_INVALID"}` — the pre-reset refresh token is dead; the reset revoked all of the user's refresh tokens (AM-E/R1).
- **Status**: ✅ pass

---

### Area D — Rate limiting (live)

> **Order dependency / timing**: slowapi storage is in-memory per-process and keyed by
> client IP; all localhost curls share one IP. TC-D1 **exhausts the login limit for
> ~1 minute**, and TC-D2 exhausts the register limit for ~1 hour. Run **Area D last**,
> after A/B/C. To reset between runs, restart the live server (storage is
> per-process). Default limits (plan §config): login `10/minute`, register `5/hour`,
> forgot-password `5/hour`.

#### TC-D1: login 429 after threshold; body is normalized `{"detail":"RATE_LIMITED"}`
- **Method/Endpoint**: POST `/auth/login` repeated past the limit
- **Expected**: first N within limit → 400 (bad creds) / 200; once the limit trips →
  `429` with body **exactly** `{"detail":"RATE_LIMITED"}` (custom handler normalizes
  slowapi's stock `{"error":...}` to the single `detail` envelope, AM-I/R5 — **NOT**
  `{"error":...}`).
- **curl**:
```bash
for i in $(seq 1 15); do
  curl -s -o /dev/null -w "%{http_code} " -X POST "$BASE/auth/login" -H "$CT_FORM" \
    --data-urlencode "username=$EMAIL" --data-urlencode "password=wrong"
done; echo
# capture one 429 body:
curl -s -X POST "$BASE/auth/login" -H "$CT_FORM" \
  --data-urlencode "username=$EMAIL" --data-urlencode "password=wrong"
```
- **Actual**: sequence `400 400 400 400 400 400 400 400 400 400 429 429 429 429 429` — exactly 10 `400`s within limit, then `429`. Captured 429 body = `{"detail":"RATE_LIMITED"}` (normalized single envelope, not `{"error":...}`).
- **Status**: ✅ pass

#### TC-D2: register 429 — post-decorated stock route (AM-D one-time end-to-end proof)
- **Method/Endpoint**: POST `/auth/register` repeated past `5/hour`
- **Expected**: a `429` appears once the limit trips. This exercises the **fragile
  post-decoration of the stock router endpoint** (plan Risks) — the reason it exists
  as a live proof even though AM-D adds a CI pytest for it.
- **curl**:
```bash
for i in $(seq 1 7); do
  curl -s -o /dev/null -w "%{http_code} " -X POST "$BASE/auth/register" -H "$CT_JSON" \
    -d "{\"email\":\"rl-$i-$(date +%s)@example.com\",\"password\":\"$PW\"}"
done; echo   # expect trailing 429(s)
```
- **Actual**: sequence `201 201 429 429 429 429 429` — 3 registers were already consumed earlier this run (TC-E3, TC-A1, TC-B6), so 2 more succeeded to reach the `5/hour` cap, then trailing `429`s. Post-decorated stock router endpoint rate-limits correctly.
- **Status**: ✅ pass

#### TC-D3: 429 single-envelope assertion (normalized contract, AM-I)
- **Scenario**: verify the normalized single-envelope contract — the 429 body captured
  in TC-D1/TC-D2 is `{"detail": <str>}` with **no** `error` key, so the declared 429
  response schema (`{detail: str}` on limited routes) matches the live body exactly.
  One `detail` envelope across the entire API; no client-facing one-off shape remains.
- **Command**:
```bash
# reusing a captured 429 response body $BODY429:
echo "$BODY429" | jq 'has("detail"), has("error")'   # expect: true, false
```
- **Actual**: `[true, false]` — 429 body has `detail`, no `error` key. Single `detail` envelope API-wide (AM-I).
- **Status**: ✅ pass

#### TC-D4: 429 declared in openapi.json for limited routes
- **Scenario**: the client types must be honest — `429` declared on login, register,
  forgot-password (§10).
- **Command**:
```bash
cd /Users/nikitazaretski/work/budget/apps/api
for p in /auth/login /auth/register /auth/forgot-password; do
  echo -n "$p 429: "; jq --arg p "$p" '.paths[$p].post.responses["429"] != null' openapi.json
done   # expect: true true true
```
- **Actual**: `/auth/login 429: true`, `/auth/register 429: true`, `/auth/forgot-password 429: true`.
- **Status**: ✅ pass

---

### Area E — Migration lifecycle (command checks against the `budget` DB)

> **Runs at /implement time as well** — these are also acceptance criteria in plan.md.
> QA re-runs them at /test against the live `budget` DB. Requires the alembic CLI and
> `DATABASE_URL` pointed at `budget`.

#### TC-E1: upgrade → downgrade → upgrade → check reports no diff
- **Command**:
```bash
cd /Users/nikitazaretski/work/budget/apps/api
export DATABASE_URL="$PGURL"
uv run alembic upgrade head \
 && uv run alembic downgrade base \
 && uv run alembic upgrade head \
 && uv run alembic check     # expect: "No new upgrade operations detected."
```
- **Expected**: all four succeed; `alembic check` reports no diff (0001 is faithful).
- **Actual**: `upgrade head` (already at head) → `downgrade base` (dropped users + refresh_tokens) → `upgrade head` (re-created 0001) → `alembic check`: **"No new upgrade operations detected."** All four succeeded; DATABASE_URL used the asyncpg form (`postgresql+asyncpg://...@5443/budget`) since alembic env sources the async engine URL from Settings.
- **Status**: ✅ pass

#### TC-E2: table + constraint/index names match the naming convention
- **Note**: `email` is declared `unique=True, index=True`, so SQLAlchemy emits a single
  **UNIQUE INDEX** `ix_users_email` — there is **NO** `uq_users_email` constraint
  (AM-J). Indexes are not visible in `pg_constraint`; query `pg_indexes` for them.
- **Command**:
```bash
psql "$PGURL" -c "\d+ users"
psql "$PGURL" -c "\d+ refresh_tokens"
# constraints (PK/FK only — no uq_users_email exists):
psql "$PGURL" -tAc "SELECT conname FROM pg_constraint WHERE conname LIKE 'pk_%' OR conname LIKE 'fk_%' ORDER BY 1;"
# indexes (ix_users_email must be UNIQUE):
psql "$PGURL" -tAc "SELECT indexname, indexdef FROM pg_indexes WHERE indexname IN ('ix_users_email','ix_refresh_tokens_user_id') ORDER BY 1;"
```
- **Expected**:
  - via `pg_constraint`: `pk_users`, `pk_refresh_tokens`,
    `fk_refresh_tokens_users_user_id` (and **no** `uq_users_email`);
  - via `pg_indexes`: `ix_users_email` whose `indexdef` contains `UNIQUE`, and
    `ix_refresh_tokens_user_id`;
  - `users.id` native `uuid`; `created_at` is `timestamptz`; no
    `fastapi_users_db_sqlalchemy` types.
- **Actual**: `pg_constraint`: `fk_refresh_tokens_users_user_id`, `pk_refresh_tokens`, `pk_users` — and `uq_users_email` count = **0** (does not exist). `pg_indexes`: `ix_users_email` → `CREATE UNIQUE INDEX ... ON public.users (email)`; `ix_refresh_tokens_user_id` present. `users.id` = native `uuid`; `created_at` = `timestamp with time zone`; FK `ON DELETE CASCADE` shown in `\d+`; no `fastapi_users_db_sqlalchemy` types. `refresh_tokens.token` = `varchar(43)` PK.
- **Status**: ✅ pass

#### TC-E3: refresh_tokens FK ON DELETE CASCADE behaves
- **Scenario**: deleting a user row removes their refresh tokens atomically (§6).
- **Command**:
```bash
# register + login to create a real refresh_tokens row, then delete the user:
CE="cascade+$(date +%s)@example.com"
curl -s -o /dev/null -X POST "$BASE/auth/register" -H "$CT_JSON" -d "{\"email\":\"$CE\",\"password\":\"$PW\"}"
curl -s -o /dev/null -X POST "$BASE/auth/login" -H "$CT_FORM" --data-urlencode "username=$CE" --data-urlencode "password=$PW"
psql "$PGURL" -tAc "SELECT count(*) FROM refresh_tokens rt JOIN users u ON u.id=rt.user_id WHERE u.email='$CE';"  # expect >=1
psql "$PGURL" -c "DELETE FROM users WHERE email='$CE';"
psql "$PGURL" -tAc "SELECT count(*) FROM refresh_tokens WHERE user_id NOT IN (SELECT id FROM users);"  # expect 0 (tokens gone)
```
- **Expected**: token count ≥1 before delete, 0 orphans after.
- **Actual**: register `201`, login `200`; token count before delete = `1`; `DELETE 1` on the user row; orphan tokens after = `0`. FK `ON DELETE CASCADE` removes refresh tokens atomically.
- **Status**: ✅ pass

---

### Area F — Contract / drift checks (committed artifacts)

#### TC-F1: drift red before regeneration, green after *(⚠ /implement-time-only)*
- **Scenario**: auth endpoints change the schema — the drift tests
  (`test_openapi_export.py` + api-client `drift.test.ts`) must be **red before**
  `pnpm openapi` and **green after** both artifacts are regenerated and committed.
- **Note**: this transient red→green transition is only observable **during
  /implement**, before the commit. At /test the artifacts are already committed and
  green — QA verifies the green end state via `pnpm test`. Flagged as implement-time.
- **Command (implement-time)**: after code, before regen → `pnpm test` shows drift
  failures; run `pnpm openapi`; commit both; `pnpm test` green.
- **Actual**: Not runnable at /test — the transient red→green drift transition is only observable during /implement before the regen+commit. At /test the artifacts are already committed and consistent (senior-lead diff gate reported contract artifacts verified; independently corroborated by TC-F2–F5 and TC-H1/H2 matching the live server). Marked blocked as implement-time-only.
- **Status**: 🚫 blocked (implement-time-only; end state verified green via F2–F5, H1/H2)

#### TC-F2: committed openapi.json contains the new auth/users paths
- **Command**:
```bash
cd /Users/nikitazaretski/work/budget/apps/api
for p in /auth/register /auth/login /auth/refresh /auth/logout \
         /auth/forgot-password /auth/reset-password /users/me; do
  echo -n "$p: "; jq --arg p "$p" '.paths[$p] != null' openapi.json
done   # expect all true
```
- **Actual**: all 7 paths `true` — `/auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/forgot-password`, `/auth/reset-password`, `/users/me`.
- **Status**: ✅ pass

#### TC-F3: securitySchemes has OAuth2 password flow, tokenUrl /auth/login
- **Command**:
```bash
cd /Users/nikitazaretski/work/budget/apps/api
jq '.components.securitySchemes' openapi.json
jq '[.components.securitySchemes[] | select(.type=="oauth2") | .flows.password.tokenUrl]' openapi.json
```
- **Expected**: an `oauth2` scheme whose `flows.password.tokenUrl == "/auth/login"`
  (S2). Protected routes (`/users/me`) carry per-route `security`.
- **Actual**: `{"OAuth2PasswordBearer":{"flows":{"password":{"scopes":{},"tokenUrl":"/auth/login"}},"type":"oauth2"}}`; oauth2 `tokenUrl` list = `["/auth/login"]`.
- **Status**: ✅ pass

#### TC-F4: /auth/login requestBody is application/x-www-form-urlencoded
- **Command**:
```bash
cd /Users/nikitazaretski/work/budget/apps/api
jq '.paths["/auth/login"].post.requestBody.content | keys' openapi.json
```
- **Expected**: `["application/x-www-form-urlencoded"]` (the only non-JSON request in
  the API, §10).
- **Actual**: `["application/x-www-form-urlencoded"]` — the only non-JSON request body in the API.
- **Status**: ✅ pass

#### TC-F5: UserRead is lean — no is_superuser / is_verified
- **Command**:
```bash
cd /Users/nikitazaretski/work/budget/apps/api
jq '.components.schemas.UserRead.properties | keys' openapi.json
jq '.components.schemas.UserRead.properties | has("is_superuser"), has("is_verified")' openapi.json
```
- **Expected**: keys are exactly `id`, `email`, `is_active`; both `has(...)` → false.
  Also confirm the PATCH request schema (`UserUpdate`) exposes only `email`/`password`
  (AM-A).
- **Actual**: `UserRead.properties` keys = `["email","id","is_active"]`; `has("is_superuser"), has("is_verified")` = `[false, false]`. `UserUpdate.properties` keys = `["email","password"]` (AM-A lean PATCH schema).
- **Status**: ✅ pass

#### TC-F6: health endpoint contract unchanged (0.2 still holds)
- **Scenario**: `/health` from stage 0.2 must be untouched — 200 contract preserved.
- **Command**:
```bash
curl -s -w '\n%{http_code}\n' "$BASE/health"          # expect 200 {status, database}
cd /Users/nikitazaretski/work/budget/apps/api
jq '.paths["/health"].get.responses | keys' openapi.json   # expect ["200","503"]
```
- **Actual**: `GET /health` → `200` `{"status":"ok","database":"ok"}`; openapi `/health` responses keys = `["200","503"]`. 0.2 contract unchanged.
- **Status**: ✅ pass

---

### Area G — Swagger UI (manual)

#### TC-G1: "Authorize" works against /auth/login
- **Scenario**: open `http://localhost:8000/docs` → click **Authorize** → the OAuth2
  password dialog posts to `/auth/login`; enter `$EMAIL` / password → authorized →
  "Try it out" on `GET /users/me` returns `200` with the lean body.
- **Expected**: Swagger authorizes via the custom `/auth/login` and the protected call
  succeeds (S2 confirmed live).
- **Actual**: No browser available in this environment, so the interactive "Authorize" click cannot be exercised. Mechanical prerequisites verified via curl: `GET /docs` → `200`, `content-type: text/html`; openapi oauth2 `tokenUrl` = `/auth/login`. The underlying `/auth/login` password flow + protected `/users/me` were proven live in TC-A2/A3. The manual Swagger click-through remains.
- **Status**: ⚠ prerequisites-verified / manual-step-remaining (NOT a full pass)

---

### Area H — Generated typed-client sanity

#### TC-H1: schema.d.ts contains TokenPair
- **Command**:
```bash
grep -n "TokenPair" /Users/nikitazaretski/work/budget/packages/api-client/src/generated/schema.d.ts
```
- **Expected**: a `TokenPair` type with `access_token`, `refresh_token`, `token_type`.
- **Actual**: `TokenPair` type present (schema.d.ts:253) with `access_token: string`, `refresh_token: string`, `token_type` (`@default bearer`, constant). Also referenced as the login/refresh response body (lines 405, 478).
- **Status**: ✅ pass

#### TC-H2: schema.d.ts contains the urlencoded login body type
- **Command**:
```bash
grep -nE "Body_login_auth_login_post|x-www-form-urlencoded" \
  /Users/nikitazaretski/work/budget/packages/api-client/src/generated/schema.d.ts
```
- **Expected**: the auto-named form body type for `/auth/login` (FastAPI emits
  `Body_login_auth_login_post`, §10) — proves the urlencoded login surface reached the
  client types.
- **Actual**: `Body_login_auth_login_post` type present (schema.d.ts:168) and referenced as `"application/x-www-form-urlencoded": components["schemas"]["Body_login_auth_login_post"]` (line 395). The urlencoded login surface reached the client types.
- **Status**: ✅ pass

---

## Coverage note — plan.md pytest cases deliberately NOT duplicated as curl

These are covered by backend pytest (plan.md "Test plan"); duplicating them as curl
would add no coverage and just re-assert what pytest proves against the same server:

- `TestRegister::test_case_insensitive_duplicate_400` — case-insensitive dedup (§13.1)
  is pure server logic; pytest already contrasts `foo@` vs `FOO@`. No live value.
- `TestLogin::test_inactive_user_400` — requires a **direct `db_session` insert** of an
  inactive user; no HTTP path creates one in 1.1, so curl cannot set it up. Pytest-only.
- `TestRefresh::test_expired_token_401` — requires a direct-insert row with
  `created_at = now-40d`; the max-age branch is unreachable over HTTP within a test run.
  Pytest-only (the DatabaseStrategy max-age math is unit-level).
- `TestRefresh::test_unknown_token_401` — the no-DB-row branch; my TC-A5/A7 already
  exercise the revoked/rotated 401 live, and TC-B5 the unknown-token no-oracle on
  logout. The garbage-token refresh branch adds nothing live.
- `TestRateLimit::test_login_429` (AM-D also adds register-429) — the CI gate. My
  TC-D1/TC-D2 are the **one-time end-to-end proof** of the fragile stock-route
  mechanism, not a re-run of the gate.
- `TestUsersMe::test_unauthenticated_401` — the single router-level auth test; my
  Section B does not repeat 401-no-token on every endpoint (per SKILL conventions,
  auth tested once per router). TC-B1 (refresh-as-Bearer 401) and TC-B8 (403 authz)
  are **distinct** security contracts, not repeats of the plain 401.

Rotation happy-path + reuse rejection appear in **both** pytest
(`TestRefresh::test_rotates_and_revokes_old`) and curl (TC-A4/A5): pytest pins the
DB-state logic, curl proves the stateful multi-request contract actually holds over the
wire against a live server. Documented as intentional overlap.

---

## Summary

### Pytest (Section A) — verified via `uv run pytest`
- Total: **22** collected (run with `TEST_DATABASE_URL=...@5443/budget_test uv run pytest -q`)
- ✅ Pass: **22**
- ❌ Fail: **0**

### Curl / command (Section B)
- Total: **36** — A:7, B:8, C:5, D:4, E:3, F:6, G:1, H:2
- ✅ Pass: **33**  ❌ Fail: **0**  ⚠ Caveated: **2** (TC-A4, TC-G1)  🚫 Blocked: **1** (TC-F1)
- ⚠ **TC-A4** — refresh-rotation contract holds (refresh token rotated; access token
  independently re-verified to differ across a >1s boundary). The `new_access != old`
  sub-assertion tripped only because login+refresh landed in the same wall-clock second
  and the access JWT's `exp` is 1s-granular → byte-identical string. Timing artifact of
  the QA assertion, **not a product defect**.
- ⚠ **TC-G1** — Swagger "Authorize" is a browser step; no browser here. All mechanical
  prerequisites verified via curl (`/docs` 200 HTML; oauth2 `tokenUrl` = `/auth/login`;
  password flow proven live in A2/A3). One manual click-through remains.
- 🚫 **TC-F1** — the red→green drift transition is only observable at /implement before
  the regen+commit. End state verified green at /test via F2–F5 + H1/H2.
- Env note: live server ran on **port 8010** (port 8000 is held by a FOREIGN project's
  container `ms_restaurants_v2`, returns 401 — not touched). No server restarts were
  needed; in-memory rate-limit storage was intact throughout. Register budget was
  tracked across areas (E3, A1, B6 = 3 before Area D, so TC-D2's `5/hour` cap tripped
  after 2 more).

**Overall**: ✅ **READY FOR REVIEW** — Section A green (22/22); Section B has **0 hard
failures**. The two ⚠ (A4 timing artifact, G1 browser-only manual step) and one 🚫 (F1
implement-time-only) are non-blocking and documented above; senior-lead to confirm the
G1 manual Swagger click and the A4 timing rationale before merge.
