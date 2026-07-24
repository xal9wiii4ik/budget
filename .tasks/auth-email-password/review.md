# Code Review — auth-email-password (roadmap 1.1)

Mode: full review (security-critical task — review priorities per senior-lead brief)
Loaded rules from: `~/.claude/skills/code-review/SKILL.md`, `~/.claude/skills/pytest-conventions/SKILL.md` (no project-root CLAUDE.md exists)
Intent: architecture.md (binding) + plan.md + grooming-review.md rulings R1–R5 / amendments AM-A…AM-K. Reviewed the full uncommitted working tree at HEAD 7a8f38a.

Verification performed during review (read-only + test DB `:5443`, restored afterwards):
`uv run pytest` — 22 passed; `ruff check` / `ruff format --check` — clean; `pyright` — 0 errors;
`jq` contract checks on `openapi.json`; source inspection of installed fastapi 0.139.2 /
slowapi 0.1.10 / fastapi-users 15.0.5 to verify the mechanisms the code relies on; two live
edge-case probes against a throwaway app (findings 1–2 below are **reproduced**, not theoretical).

---

## Numbered findings

### 1. 🟠 important [Edge Case / FastAPI] — `PATCH /users/me {"email": null}` returns an unhandled 500
**File:** `apps/api/src/budget_api/schemas/user.py:44` (surfaces via fastapi-users `_update` → `SQLAlchemyUserDatabase.update`)

`UserUpdate.email: EmailStr | None = None` accepts an explicit JSON `null`. Because
`create_update_dict()` uses `exclude_unset=True` (not `exclude_none`), an explicit null is
*set* and flows into the library's `_update`: `get_by_email(None)` finds nothing →
`UserNotExists` → `validated_update_dict["email"] = None` → `UPDATE users SET email = NULL`
→ `NotNullViolationError` → **unhandled `IntegrityError`, HTTP 500**. Reproduced live:
`patch email:null -> IntegrityError (NotNullViolationError: null value in column "email")`.

No data corruption (the commit fails, session rolls back) and the endpoint is
authenticated-only, but a schema-valid request producing a 500 on the security-critical
router should not ship. Stock `BaseUserUpdate` has the same latent shape, but AM-A made this
schema *ours* — so the fix is ours too, and it is one line:

```python
class UserUpdate(CreateUpdateDictModel):
    ...
    def create_update_dict(self) -> dict[str, Any]:
        return self.model_dump(exclude_unset=True, exclude_none=True)
```

Explicit nulls become "field not updated", which matches the lenient contract already ruled
in R4/AM-H (unknown extras ignored). This also fixes finding 2 for free. Add one test
asserting `PATCH /users/me {"email": null}` → 200 with email unchanged (a genuinely
breakable path, per pytest-conventions).

### 2. 🟡 nit [Logic] — `{"password": null}` PATCH revokes all refresh tokens without changing the password
**File:** `apps/api/src/budget_api/auth.py:98`

`on_after_update` triggers revocation on `"password" in update_dict`, but the library's
`_update` only re-hashes when the value is not None (`elif field == "password" and value is
not None`). An explicit `{"password": null}` therefore changes nothing yet logs the user out
everywhere. Reproduced live: `patch password:null -> 200`, then the pre-PATCH refresh token
→ `401 REFRESH_TOKEN_INVALID`. Fails in the conservative direction (over-revokes, never
under-revokes), so only a nit — but if finding 1's `exclude_none` fix lands, this case
disappears; otherwise change the guard to `if update_dict.get("password") is not None:`.

### 3. 🟠 important [Test Coverage] — the refresh route's `is_active` re-check is unpinned; grooming record claims it is pinned
**File:** `apps/api/src/budget_api/routers/auth.py:90` (gap in `apps/api/tests/test_auth.py::TestRefresh`)

grooming-review.md §6.3: *"both custom routes re-check explicitly; pinned by
`test_inactive_user_400` **and the refresh-path equivalent**."* The refresh-path equivalent
does not exist — neither in plan.md's test list nor in the code. Today, deleting
`or not user.is_active` from the refresh route passes all 22 tests. `DatabaseStrategy.read_token`
verifiably does NOT check `is_active` (confirmed against installed source: it only does
`user_manager.get(id)`), so a deactivated user holding a live refresh token would keep
minting fresh access JWTs for up to 30 days. The route code is **correct** — this is purely
a missing pin on a security branch that the grooming record already believed existed.

Fix: add `TestRefresh::test_inactive_user_401` — register + login, flip `is_active=false`
via `db_session` (pattern already exists in `TestLogin::test_inactive_user_400`), then
`POST /auth/refresh` with the still-stored token → 401 `REFRESH_TOKEN_INVALID`. ~10 lines,
reuses existing fixtures, not vacuous (it contrasts a token that IS in the DB and NOT
expired — a distinct branch from `test_unknown_token_401`/`test_expired_token_401`).

### 4. 🔵 suggestion [Architecture] — co-locate `prime_rate_limit` with the decorated routes to remove the app.py coupling
**Files:** `apps/api/src/budget_api/app.py:52`, `apps/api/src/budget_api/routers/auth.py:50`, `apps/api/src/budget_api/rate_limit.py:37`

The rate-limit callables `LookupError` on an unprimed contextvar, and priming currently
depends on `app.py` remembering `dependencies=[Depends(prime_rate_limit)]` at include time.
Because FastAPI 0.139's `include_router` shares the route objects (verified:
`_IncludedRouter(original_router=...)`, no copying), any future app/test that includes
`auth.router` without that argument gets a 500 on every limited route. Moving the priming
into the router itself — `APIRouter(prefix="/auth", tags=["auth"],
dependencies=[Depends(prime_rate_limit)])` in `routers/auth.py` — makes the module that
post-decorates the routes also guarantee their precondition, and `app.py`'s include call
loses a load-bearing argument. Related micro-nit, same area: `prime_rate_limit` sets the
contextvar without ever resetting it. Harmless today (per-request task context under
uvicorn; in-process test transport re-primes on every limited route), but a
reset-via-yield-dependency would make the lifecycle self-evidently clean.

---

## Per-file review

**File: `apps/api/src/budget_api/auth.py`** (new)
- **Changes Summary**: auth wiring — user-db factory, `UserManager` (validate_password min-8, forgot-password token log, revocation hooks), strategy factories, JWT-only `FastAPIUsers`, `current_active_user`.
- **Issues Found**: finding 2 (🟡).
- Verified in detail: `FastAPIUsers[User, uuid.UUID](get_user_manager, [jwt_backend])` — **JWT backend only, the F6 structural guarantee holds** (line 142), pinned by `test_refresh_token_rejected_as_bearer`. `_revoke_all_refresh_tokens` uses a bound `:user_id` parameter — no SQL injection surface (Dev5 execution clean); commit on the request session is correct given the adapter's own commit-per-op semantics. `reset_password` (library source) calls `_update` directly, NOT `update()` — so reset does not double-fire `on_after_update`; exactly one revocation per reset. `update_dict` carrying the raw `"password"` key was verified against `BaseUserManager.update` source. `validate_password` guards register, reset AND update flows (all three route through it in 15.0.5 — confirmed in `create`/`reset_password`/`_update` source). Secrets: `jwt_secret` never logged; reset-token WARNING log is the accepted grooming decision (§6.4), not re-litigated.
- **Status**: ✅ Approved (after finding 2's one-line guard or finding 1's exclude_none)

**File: `apps/api/src/budget_api/routers/auth.py`** (new)
- **Changes Summary**: mounts stock register/reset routers; custom login/refresh/logout; post-decoration rate limiting of all three unauthenticated routes.
- **Issues Found**: finding 3 (🟠 — missing test for line 90's branch), finding 4 (🔵).
- Verified in detail: login re-checks `is_active` after `authenticate()` (which returns `None`, never raises — confirmed §13.7), single 400 `LOGIN_BAD_CREDENTIALS` for bad password AND inactive — no oracle. Refresh: read → re-check → destroy → write = correct rotation order; single 401 `REFRESH_TOKEN_INVALID` for unknown/expired/revoked/inactive — no oracle. Logout: `get_by_token` without `max_age` deliberately matches even expired rows for deletion; always 204 — no oracle. `_find_route`'s `original_router` traversal is correct for FastAPI 0.139.2 (routes are shared by reference, so decorating the stock router's own route objects propagates to every app — the Dev4 uniform post-decoration executes soundly, and the mutated `route.responses` is why 429 appears on register/forgot-password in openapi.json, verified via jq). Decoration runs once at module import; slowapi calls the zero-arg limit providers per request (verified `LimitGroup.__iter__` source), so per-app limit shrinking works. 422-rejected requests don't count against limits (slowapi checks inside the endpoint wrapper) — inherent to the decorator approach, acceptable.
- **Status**: ✅ Approved (after finding 3's test is added)

**File: `apps/api/src/budget_api/rate_limit.py`** (new)
- **Changes Summary**: process-global limiter with dynamic per-app enable/limits/storage-scope (AM-C).
- **Issues Found**: none beyond finding 4's coupling note.
- The AM-C argument the senior gate asked for is present and **checks out**: per-app `Limiter` is genuinely impossible under shared route objects (verified against installed FastAPI); the three dynamic axes (exempt_when, limit-value callables, uuid-scoped storage keys) each read the request's own app state, so two live apps cannot share counters or flags. `headers_enabled=False` tradeoff (drops Retry-After) is documented and was explicitly ruled nice-to-have in AM-I. 429 handler emits the single `{"detail": "RATE_LIMITED"}` envelope (AM-I) and is registered only for `RateLimitExceeded`.
- **Status**: ✅ Approved

**File: `apps/api/src/budget_api/schemas/user.py`** (new)
- **Changes Summary**: lean `UserRead` (independent BaseModel), `UserCreate` (stock subclass), `UserUpdate` on the fieldless `CreateUpdateDictModel` (AM-A / Dev2).
- **Issues Found**: finding 1 (🟠).
- AM-A executes correctly: `CreateUpdateDictModel` contributes zero fields (verified source), so privilege fields are structurally absent from `UserUpdate`; belt-and-suspenders, `create_update_dict` ALSO excludes them by name. `UserRead` = exactly `{id, email, is_active}` on the wire (jq-verified in openapi.json). Extras ignored per AM-H (Pydantic default, no `extra="forbid"`).
- **Status**: ❌ Needs the one-line `exclude_none` fix (finding 1)

**File: `apps/api/src/budget_api/schemas/auth.py`** (new)
- **Changes Summary**: `TokenPair` (single shape for login+refresh), `RefreshRequest`, `LogoutRequest`, `RateLimitedError`.
- **Issues Found**: None.
- **Status**: ✅ Approved

**Files: `apps/api/src/budget_api/models/user.py`, `models/refresh_token.py`, `models/__init__.py`** (new/modified)
- **Changes Summary**: own models on the naming-convention Base, TYPE_CHECKING split (Dev3), re-exports for Alembic autogen.
- **Issues Found**: None.
- Column shapes mirror the mixins exactly (email 320 unique+index, hashed_password 1024, token 43 PK, FK CASCADE). `RefreshToken.created_at` has the tz-aware **Python** default the adapter requires (`create` supplies only `{token, user_id}` — verified `_create_access_token_dict` source); `read_token`'s max-age comparison is sound against it. Dev3's split is clean: pyright strict passes with zero suppressions in the models.
- **Status**: ✅ Approved

**File: `apps/api/src/budget_api/models/base.py`** (modified)
- **Changes Summary**: Dev1 — FK naming token `referent_table` → `referred_table_name`.
- **Issues Found**: None. Verified live: the token is valid SQLAlchemy and produces `fk_refresh_tokens_users_user_id`, matching migration 0001. Zero prior tables → zero rename churn.
- **Status**: ✅ Approved

**File: `apps/api/alembic/versions/0001_users_and_refresh_tokens.py`** (new)
- **Changes Summary**: first real migration — `users` + `refresh_tokens` exactly.
- **Issues Found**: None.
- Matches the models column-for-column (server defaults on the booleans and `users.created_at`; deliberately NO server default on `refresh_tokens.created_at` — consistent with the Python-default decision). AM-J respected: single UNIQUE INDEX `ix_users_email`, no `uq_` constraint. FK named per the fixed convention, `ondelete="CASCADE"` (user delete revokes all sessions). No library imports — clean autogen output. Downgrade drops in correct dependency order (refresh_tokens before users) and is continuously validated by the test fixture (upgrade at session start, downgrade at session end — exercised in this review's own runs).
- **Status**: ✅ Approved

**File: `apps/api/src/budget_api/app.py`** (modified)
- **Changes Summary**: `app.state.settings`, shared limiter + per-app scope uuid, 429 handler, router includes with the priming dependency.
- **Issues Found**: finding 4 (🔵 — move priming into the router).
- **Status**: ✅ Approved

**Files: `apps/api/src/budget_api/config.py`, `openapi_export.py`, `.env.example`, `pyproject.toml`, `uv.lock`** (modified)
- **Changes Summary**: `jwt_secret` required (fail-fast), lifetime + rate knobs with code defaults; AM-B executed at all three explicit `Settings(...)` sites (export module comment rewritten as required, conftest, test_health); `.env.example` gains `JWT_SECRET=` with the generate-me comment; deps `fastapi-users[sqlalchemy]>=15.0.5` + `slowapi>=0.1.10` as `>=` floors with regenerated lock (convention held; transitives not pinned explicitly, per plan).
- **Issues Found**: None. Export hermeticity holds — the dummy secret cannot reach the schema (no request path runs during `app.openapi()`).
- **Status**: ✅ Approved

**File: `apps/api/tests/conftest.py`** (modified)
- **Changes Summary**: subprocess-alembic session fixture, TRUNCATE-per-test isolation, `make_client` factory with per-test settings overrides (rate limiting off by default), `db_session`.
- **Issues Found**: None.
- Fixture ordering is sound (session-scoped autouse `_migrated_schema` precedes function-scoped `_clean_tables`); the subprocess env passes both `DATABASE_URL` and `JWT_SECRET` (env vars beat `.env` in pydantic-settings — correct); `TRUNCATE ... CASCADE` covers the FK; each helper engine is disposed on the test's own loop (respects the function-scoped-loop constraint). `make_client` defaulting `rate_limit_enabled=False` decouples ordinary tests from limit tuning — the right default. Building ~3 short-lived engines per test is mildly wasteful but the suite runs in 3.8s; not worth complexity.
- **Status**: ✅ Approved

**Files: `apps/api/tests/test_auth.py`, `tests/test_users.py`, `tests/test_health.py`** (new/modified)
- **Changes Summary**: 17 auth/users tests + adjusted health test (AM-B).
- **Issues Found**: finding 3 (🟠 — missing refresh-path inactive test).
- Coverage cross-check against plan.md's list + AM-D/E/F/G: all 16 planned auth/users cases present and none vacuous — each pins a distinct branch (rotation reuse-contrast, expired-vs-unknown as genuinely different code paths, no-oracle 204/202 contracts, the F6 bearer-rejection pin, both 429 mechanisms incl. the AM-D post-decoration CI gate, both revocation paths R1/AM-E with the caplog-captured reset token, AM-F folded into the PATCH test as ruled, AM-G short-password). Conventions held: class-based, per-test isolation via helpers + TRUNCATE, zero mocks (real Postgres, real argon2, real JWT), the single 401 auth test per router. `test_login_429` also pins the AM-I envelope. The only gap is finding 3.
- **Status**: ✅ Approved (after finding 3)

**File: `apps/api/src/budget_api/routers/users.py`** (new)
- **Changes Summary**: full stock users router with lean schemas (third documented `# type: ignore[arg-type]` per AM-A).
- **Issues Found**: None. `/{id}` superuser gating was plan-verified (§13.2); dead-but-harmless in 1.1.
- **Status**: ✅ Approved

**Files: `apps/api/openapi.json`, `packages/api-client/src/generated/schema.d.ts`** (generated — contract-level sanity only)
- Both artifacts present together (drift-gate convention). Verified via jq/grep: all 9 paths; 429 with `RateLimitedError` on exactly login/register/forgot-password; `/auth/login` requestBody is urlencoded-only; `OAuth2PasswordBearer` password flow → `/auth/login` (S2); `UserRead` = id/email/is_active; `UserUpdate` = email/password; `TokenPair` = the single 3-field shape. Contract matches the design.
- **Status**: ✅ Approved

**File: `PLAN.md`** — PM status edit, skipped per brief.

---

## Genuinely well done (not padding)

- The AM-C resolution is better than either option the amendment sketched: instead of arguing per-test isolation of shared state, it verified the *actual* FastAPI 0.139 sharing semantics (routes-by-reference) and designed for them — the uuid storage scope makes cross-app bleed impossible by construction.
- The security error contracts are uniformly oracle-free and every one of them is test-pinned, including the easy-to-forget 204-for-unknown-logout and 202-for-unknown-email.
- Capturing `user_db.session` in `UserManager.__init__` *before* the `super().__init__` upcast, with the comment explaining why — a subtle typing trap handled cleanly.

## Summary table

| # | Severity | File | One-liner |
|---|---|---|---|
| 1 | 🟠 important | `schemas/user.py:44` | `PATCH /users/me {"email": null}` → unhandled IntegrityError 500 (reproduced); fix with `exclude_none` in `create_update_dict` |
| 2 | 🟡 nit | `auth.py:98` | `{"password": null}` PATCH revokes all sessions without a password change (reproduced); vanishes with #1's fix |
| 3 | 🟠 important | `routers/auth.py:90` / `tests/test_auth.py` | Refresh-route `is_active` re-check has no test; grooming §6.3 claims this pin exists — add `TestRefresh::test_inactive_user_401` |
| 4 | 🔵 suggestion | `app.py:52` / `routers/auth.py:50` | Move `prime_rate_limit` into the `APIRouter` constructor so decorated routes can never be mounted unprimed |

## Overall recommendation: **request-changes (minor)**

Two 🟠 findings, both small and mechanical: a one-line `exclude_none` override (+1 test) and
one ~10-line pytest for a security branch the grooming record already believed was pinned.
Nothing touches the design; every binding artifact decision (R1–R5, AM-A…AM-K, F6 guarantee,
rotation/no-oracle semantics, Dev1–Dev5 executions) is implemented correctly and verified.
With findings 1 and 3 addressed, this is an approve.
