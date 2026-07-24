# Implementation Plan: auth-email-password (roadmap 1.1)

This plan implements `architecture.md` (BINDING). All library claims re-verified
against the installed packages in the scratch venv (see **Verification results**).
No production code was written during grooming.

## Verification results (Phase 3.6 — done before this plan)

Verified with `inspect.getsource` / a runnable spike app against the scratch venv
(`fastapi-users 15.0.5`, `fastapi-users-db-sqlalchemy 7.0.0`, `pwdlib 0.3.0`,
`pyjwt 2.13.0`, `slowapi 0.1.10`, `limits 5.8.0`). Every architecture §13 item:

- **§13.1 email case** — `SQLAlchemyUserDatabase.get_by_email` uses
  `func.lower(email) == func.lower(...)` → **case-insensitive** lookup.
  `UserManager.create` calls `get_by_email` first, so `foo@x.com` after
  `Foo@x.com` → `UserAlreadyExists` (400). Registration dedupes case-insensitively.
  The stored value keeps original case and the plain unique index on `email` is
  case-sensitive (won't block a case-variant inserted directly by DB) — plain
  unique index kept at personal scale; `lower(email)` functional index is the
  documented upgrade trigger. **Confirms architecture §3/§6.**
- **§13.2 /{id} gating** — GET/PATCH/DELETE `/{id}` in `get_users_router` all carry
  `dependencies=[Depends(get_current_superuser)]`. **Full-stock mount is safe**
  (no superuser exists in 1.1 → dead-but-harmless). No fallback needed.
- **§13.3 reset router** — `get_reset_password_router` mounts cleanly.
  `/forgot-password` returns **202 always** (catches `UserNotExists` and
  `UserInactive` → returns None) — **no account-existence oracle, confirmed**.
  `UserManager` must define `reset_password_token_secret` **and**
  `verification_token_secret` (both are required class annotations even though we
  skip the verify router); `reset_password_token_lifetime_seconds` defaults 3600.
- **§13.4 strategy signatures** — `DatabaseStrategy.read_token(token, user_manager)
  -> UP | None` enforces max-age via `created_at >= now-lifetime` but does **NOT**
  check `is_active` (it just `user_manager.get`s by id). **Custom refresh/login
  routes must re-check `is_active`** (architecture §1 already requires this).
  `write_token(user) -> str`, `destroy_token(token, user) -> None`. The SQLAlchemy
  adapter's `create`/`delete` **commit the session internally** and `create`
  refreshes, so `created_at` must have a model-level default (the library mixin
  uses a Python `default=now_utc`, tz-aware — we mirror that).
- **§13.5 lean schemas + safe register** — `get_register_router`/`get_users_router`
  do `response_model=user_schema` + `user_schema.model_validate(user)`. `create(safe=
  True)` uses `create_update_dict()` which excludes `is_superuser/is_active/
  is_verified` → **privilege fields ignored on register, confirmed.** See **S1**.
- **§13.6 slowapi** — `slowapi 0.1.10`, `limits 5.8.0`. `Limiter(key_func,
  enabled=True, ...)`; **`enabled=False` fully disables** (spike: 4/4 pass). Owned
  route + `@limiter.limit("2/minute")` + `app.state.limiter` +
  `add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)` → spike
  gave 200,200,429 with **no SlowAPIMiddleware needed** (decorator `auto_check=True`).
  **429 body is `{"error": "Rate limit exceeded: ..."}`** (NOT `{"detail": ...}`).
  Decorator requires the route to have a `request: Request` parameter. Stock routes
  we don't own can be limited by post-decorating `route.endpoint` +
  `route.dependant.call` (spike verified 200,200,429) — see **Disagreements/Risks**.
- **§13.7 exceptions** — `authenticate()` returns `None` (no exception) on bad creds
  and **does not check is_active**. Custom errors surface as `UserAlreadyExists`,
  `InvalidPasswordException(.reason)`, `InvalidResetPasswordToken`, `UserNotExists`,
  `UserInactive`, `InvalidID`. Custom login/refresh handle `None`, not exceptions.
- **§13.8 test-DB** — design decision, see **Database changes** + **Test plan**.

**S1 (lean UserRead):** The router bound is `type[schemas.U]` where
`U = TypeVar("U", bound=schemas.BaseUser)`. Pydantic v2 **cannot drop** inherited
fields, so subclassing `BaseUser` keeps `is_superuser`/`is_verified` (spike: they
appear in the schema). A genuinely lean `UserRead {id, email, is_active}` **is
achievable** as an independent `BaseModel(from_attributes=True)`: the spike proved
`model_validate` reads it from an ORM object and the emitted schema has **exactly
id/email/is_active**. Cost: passing a non-`BaseUser` model trips the generic bound
under pyright strict → **one `# type: ignore[arg-type]` per router registration**
(register + users). **Plan uses the lean independent model** (architecture §5/§12
wants it; the two suppressions are localized and documented). Recorded fallback if
senior-lead rejects the suppressions: stock 5-field `BaseUser` subclass.

**S2 (OAuth2 security scheme with a custom login):**
`BearerTransport(tokenUrl="/auth/login")` → the `OAuth2PasswordBearer` scheme lands
in `components.securitySchemes` as an `oauth2` password flow with
`tokenUrl: /auth/login`, and **per-route `security: [{OAuth2PasswordBearer: []}]`
appears on every route depending on the Authenticator** — spike confirmed on the
stock `/users/me` AND on a custom `Depends(current_active_user)` route. The scheme
is emitted because the authenticator is used by mounted protected routes (we mount
`/users`). Swagger "Authorize" posts to our custom `/auth/login`. **Confirmed.**

## Approach

Implement architecture Decision A (§1): keep fastapi-users' **stock** register /
reset / users routers, and add **three thin custom routes** — `POST /auth/login`,
`/auth/refresh`, `/auth/logout` — that drive the library's `JWTStrategy` (access)
and `DatabaseStrategy` (opaque, DB-stored, revocable refresh) primitives directly.
`FastAPIUsers` is constructed with the **JWT backend only** (F6), so an opaque
refresh token can never authenticate a protected route (structural, pinned by test).

Own SQLAlchemy models (`User`, `RefreshToken`) on our naming-convention `Base` —
the library mixins fight four conventions (F5) and the adapters accept any
protocol-shaped model (F4/F5). Migration 0001 = `users` + `refresh_tokens` only
(`oauth_accounts`/`profiles` deferred per architecture §4, PM-confirmed). Lean
own Pydantic schemas keep privilege fields structurally absent from the wire.
slowapi guards `/auth/login` (and register/forgot-password) with a test-mode
`enabled=False` switch. Settings gain `jwt_secret` + lifetime/rate knobs, read from
`app.state.settings` (never module-level `get_settings()`), per §8.

Trade-offs: two documented `# type: ignore[arg-type]` for the lean `UserRead`;
plaintext refresh tokens at rest (F4 — DatabaseStrategy behavior, DB compromise of a
single-user app is game-over anyway); refresh-token body pair (XSS-reachable on web)
over httpOnly cookie (architecture §1 D2, matches the doc, single contract).

## Files to modify

- `apps/api/pyproject.toml` — add to `[project].dependencies`:
  `fastapi-users[sqlalchemy]>=15.0.5`, `slowapi>=0.1.10`. Verified: the
  `[sqlalchemy]` extra pulls `fastapi-users-db-sqlalchemy>=7.0.0`; fastapi-users
  core already pins `pwdlib[argon2,bcrypt]==0.3.0`, `pyjwt[crypto]`,
  `python-multipart`, `email-validator`, `makefun` — **do not add these
  explicitly** (transitive). slowapi pulls `limits`, `deprecated`, `wrapt`. Regen
  `uv.lock` (exact-pin-via-lock convention, F8).
- `apps/api/src/budget_api/config.py` — new `Settings` fields (§8): `jwt_secret:
  str` (required, no default), `access_token_lifetime_seconds: int = 900`,
  `refresh_token_lifetime_seconds: int = 2_592_000`, `rate_limit_enabled: bool =
  True`, `login_rate_limit: str = "10/minute"`, `register_rate_limit: str =
  "5/hour"`, `forgot_password_rate_limit: str = "5/hour"`.
- `apps/api/src/budget_api/app.py` — `create_app`: set `app.state.settings =
  resolved` (needed by strategy/manager factories at request time and by the
  openapi export); build the slowapi `Limiter` and set `app.state.limiter`, add the
  `RateLimitExceeded` handler; `include_router(auth.router)` and
  `include_router(users.router)`.
- `apps/api/src/budget_api/models/__init__.py` — re-export `User`, `RefreshToken`
  so Alembic autogenerate sees them (F8).
- `apps/api/.env.example` — add `JWT_SECRET=` with a
  `python -c "import secrets; print(secrets.token_urlsafe(32))"` generate-me comment
  (§8). Lifetimes/rate limits keep code defaults, not surfaced (avoid speculative
  knobs; they exist as fields so tests can shrink them).
- `apps/api/tests/conftest.py` — add the schema/session/isolation fixtures (see
  **Database changes** + **Test plan**).

## New files

- `apps/api/src/budget_api/models/user.py` — `User(Base)`.
- `apps/api/src/budget_api/models/refresh_token.py` — `RefreshToken(Base)`.
- `apps/api/src/budget_api/schemas/user.py` — `UserRead`, `UserCreate`, `UserUpdate`.
- `apps/api/src/budget_api/schemas/auth.py` — `TokenPair`, `RefreshRequest`,
  `LogoutRequest`.
- `apps/api/src/budget_api/auth.py` — the wiring glue (sibling of `db.py`): user-db
  factory, `UserManager`, strategy factories, JWT backend, `FastAPIUsers` instance,
  and the canonical `current_active_user`. **Single definition point every later
  task imports** (architecture §3/§9).
- `apps/api/src/budget_api/routers/auth.py` — stock register + reset routers +
  custom login/refresh/logout.
- `apps/api/src/budget_api/routers/users.py` — stock users router.
- `apps/api/alembic/versions/0001_*.py` — first real migration (see **Database
  changes**).
- `apps/api/tests/test_auth.py`, `apps/api/tests/test_users.py` — pytest (see
  **Test plan**).

## Code skeletons

### models/user.py, models/refresh_token.py
```python
class User(Base):
    __tablename__ = "users"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    hashed_password: Mapped[str] = mapped_column(String(1024))
    is_active: Mapped[bool] = mapped_column(default=True, server_default=true())
    is_superuser: Mapped[bool] = mapped_column(default=False, server_default=false())
    is_verified: Mapped[bool] = mapped_column(default=False, server_default=false())
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now())

class RefreshToken(Base):
    __tablename__ = "refresh_tokens"
    token: Mapped[str] = mapped_column(String(43), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True)
    # tz-aware Python default mirrors the library mixin (now_utc) — adapter.create
    # sets no created_at, so the model must default it (§13.4).
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow)  # _utcnow = lambda: datetime.now(UTC)
```
Native `sqlalchemy.Uuid` (not the library `GUID`), our naming convention → churn-free
autogenerate (F5/F8).

### schemas — lean, escalation fields structurally absent (§5, S1)
```python
class UserRead(BaseModel):                       # NOT a BaseUser subclass (S1)
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    email: EmailStr
    is_active: bool
class UserCreate(schemas.BaseUserCreate): ...    # {email, password} (+ ignored priv fields, safe=True drops them)
class UserUpdate(schemas.BaseUserUpdate):        # redefine to ONLY:
    email: EmailStr | None = None
    password: str | None = None
class TokenPair(BaseModel):        # login AND refresh — one shape
    access_token: str; refresh_token: str; token_type: Literal["bearer"] = "bearer"
class RefreshRequest(BaseModel):   refresh_token: str
class LogoutRequest(BaseModel):    refresh_token: str
```
`UserCreate` stays a `BaseUserCreate` subclass (satisfies the `UC` bound cleanly);
`UserUpdate` redefines the three privilege fields away (bound `UU` = `BaseUserUpdate`
is still satisfied by subclassing + narrowing). `UserRead` is independent → the two
`# type: ignore[arg-type]` at router registration (S1).

### auth.py — wiring
```python
async def get_user_db(session: AsyncSession = Depends(get_session)) -> AsyncIterator[SQLAlchemyUserDatabase[User, uuid.UUID]]:
    yield SQLAlchemyUserDatabase(session, User)

class UserManager(UUIDIDMixin, BaseUserManager[User, uuid.UUID]):
    def __init__(self, user_db, settings: Settings) -> None:
        super().__init__(user_db)
        self.reset_password_token_secret = settings.jwt_secret     # §13.3 required
        self.verification_token_secret = settings.jwt_secret       # required attr even w/o verify router
    async def on_after_register(self, user, request=None) -> None: ...   # log-only no-op (§4; 1.2 extends)
    async def on_after_forgot_password(self, user, token, request=None) -> None: ...  # log token at WARNING (§5)

async def get_user_manager(request: Request, user_db=Depends(get_user_db)) -> AsyncIterator[UserManager]:
    yield UserManager(user_db, request.app.state.settings)          # settings from app.state, not module-level (§8)

def get_jwt_strategy(request: Request) -> JWTStrategy:
    s: Settings = request.app.state.settings
    return JWTStrategy(secret=s.jwt_secret, lifetime_seconds=s.access_token_lifetime_seconds)

bearer_transport = BearerTransport(tokenUrl="/auth/login")          # S2
jwt_backend = AuthenticationBackend(name="jwt", transport=bearer_transport, get_strategy=get_jwt_strategy)
fastapi_users = FastAPIUsers[User, uuid.UUID](get_user_manager, [jwt_backend])   # JWT ONLY (F6)
current_active_user = fastapi_users.current_user(active=True)        # the canonical dependency (§3)

async def get_refresh_strategy(session: AsyncSession, settings: Settings) -> DatabaseStrategy:
    return DatabaseStrategy(SQLAlchemyAccessTokenDatabase(session, RefreshToken),
                            lifetime_seconds=settings.refresh_token_lifetime_seconds)
```

### routers/auth.py — custom routes (semantics = architecture §1)
```python
router = APIRouter(prefix="/auth", tags=["auth"])
router.include_router(fastapi_users.get_register_router(UserRead, UserCreate))       # type: ignore[arg-type]
router.include_router(fastapi_users.get_reset_password_router())
# register/forgot-password limited via _apply_limit(...) helper (see Risks)

@router.post("/login", response_model=TokenPair)
@limiter.limit(_login_rate_limit)            # callable reads app.state.settings.login_rate_limit (tests shrink)
async def login(request: Request, credentials: OAuth2PasswordRequestForm = Depends(),
                user_manager: UserManager = Depends(get_user_manager),
                session: AsyncSession = Depends(get_session)) -> TokenPair:
    user = await user_manager.authenticate(credentials)
    if user is None or not user.is_active:                      # §13.4/§13.7: authenticate does NOT check is_active
        raise HTTPException(400, detail="LOGIN_BAD_CREDENTIALS")
    access = await get_jwt_strategy(request).write_token(user)
    refresh = await (await get_refresh_strategy(session, request.app.state.settings)).write_token(user)
    return TokenPair(access_token=access, refresh_token=refresh)

@router.post("/refresh", response_model=TokenPair)
async def refresh(request: Request, body: RefreshRequest,
                  user_manager: UserManager = Depends(get_user_manager),
                  session: AsyncSession = Depends(get_session)) -> TokenPair:
    strat = await get_refresh_strategy(session, request.app.state.settings)
    user = await strat.read_token(body.refresh_token, user_manager)     # None if unknown/expired
    if user is None or not user.is_active:                              # explicit is_active re-check (§1)
        raise HTTPException(401, detail="REFRESH_TOKEN_INVALID")
    await strat.destroy_token(body.refresh_token, user)                 # ROTATION: consume old
    new_access = await get_jwt_strategy(request).write_token(user)
    new_refresh = await strat.write_token(user)
    return TokenPair(access_token=new_access, refresh_token=new_refresh)

@router.post("/logout", status_code=204)
async def logout(request: Request, body: LogoutRequest,
                 session: AsyncSession = Depends(get_session)) -> Response:
    # revoke-by-possession; always 204, even unknown token (no oracle). destroy_token
    # is a no-op for unknown tokens (adapter get_by_token -> None).
    strat = await get_refresh_strategy(session, request.app.state.settings)
    await strat.database.get_by_token(body.refresh_token) ... delete if present
    return Response(status_code=204)
```
Declare `429` in `responses=` on login (and register/forgot-password) so the client
types are honest (§10); note the 429 body is `{"error": str}` (slowapi), not
`{"detail": ...}` — a one-off error shape to document for 1.5.

### routers/users.py
```python
router = fastapi_users.get_users_router(UserRead, UserUpdate)   # type: ignore[arg-type]
# mounted at prefix="/users" in app.py; full stock (/{id} superuser-gated, §13.2)
```

## Existing patterns to reuse

- `budget_api/db.py:get_session` — request-scoped `AsyncSession`; all auth DI chains
  off it (never manual session/engine construction).
- `app.state` pattern (`db.py` reads `app.state.sessionmaker`) — mirrored for
  `app.state.settings` and `app.state.limiter`.
- `config.py` explicit `Settings(...)` construction (tests never touch `get_settings`
  cache) — auth deps read `request.app.state.settings`, so tests inject shrunk knobs.
- `openapi_export.py` hermetic build — unchanged; it builds the full app (routers +
  limiter) with a dummy DSN and never hits the DB, so the new endpoints export fine.
- `models/base.py:Base` naming convention — both new models attach to it.
- `conftest.py` `client` fixture (lifespan-managed httpx) + fail-fast DB probe —
  reused; extended with schema/session/isolation fixtures.

## Database changes

Reference architecture §3 (exact DDL) and §4 (table set). **Migration 0001 =
`users` + `refresh_tokens` only.** `oauth_accounts` deferred to 5.1, `profiles` to
1.2 (PM-confirmed, architecture §4/§11).

**Authoring workflow:** `uv run alembic revision --autogenerate -m "users and
refresh_tokens"` against an empty `budget` DB, then **hand-review**: expect two
`create_table`s with naming-convention names (`pk_users`, `uq_users_email`,
`ix_users_email`, `pk_refresh_tokens`, `fk_refresh_tokens_users_user_id`,
`ix_refresh_tokens_user_id`), native `sa.Uuid`, `sa.DateTime(timezone=True)`, FK
`ondelete="CASCADE"`, no `fastapi_users_db_sqlalchemy` imports (own models → clean).
Remove any autogen noise. **Validate:** `alembic upgrade head` → `alembic downgrade
base` → `alembic upgrade head` → `alembic check` reports no diff.

**§13.8 test-DB story (design decision):** session-scoped fixture runs **`alembic
upgrade head` via subprocess** against `TEST_DATABASE_URL` (passed as `DATABASE_URL`
to the child) at session start, and `alembic downgrade base` at session end.
Rationale over `Base.metadata.create_all`: (1) the test schema IS the real migration
output, so tests can't pass against a schema 0001 wouldn't produce — continuous
validation of the first real migration for free; (2) subprocess avoids the
`asyncio.run` inside `alembic/env.py` colliding with pytest's running event loop.
**Per-test isolation:** function-scoped autouse fixture `TRUNCATE users,
refresh_tokens RESTART IDENTITY CASCADE` (CASCADE covers the FK). Add a `db_session`
fixture (AsyncSession from a test sessionmaker) for direct row setup (inactive user,
expired token). Local port note: `TEST_DATABASE_URL` on this machine is `:5443`;
committed default `:5433` (F8).

## Open questions

1. **Lean `UserRead` suppressions (S1):** plan uses the independent lean model with
   two documented `# type: ignore[arg-type]` at router registration. Confirm
   senior-lead accepts these under pyright strict; else fall back to the stock
   5-field `BaseUser` subclass (no suppressions, exposes is_superuser/is_verified).
2. **Rate-limiting stock routes (§13.6 / Risks):** limiting `/auth/register` +
   `/auth/forgot-password` requires post-decorating stock-router endpoints (verified
   working, but touches Starlette route internals). Options: (a) apply to all three
   as architecture §7 lists — recommended, using a small `_apply_limit` helper;
   (b) rate-limit `/auth/login` only now (the explicit brute-force target; argon2
   already bounds register cost) and defer the other two. **Recommend (a)**; flag if
   senior-lead prefers (b) to avoid the internals coupling.

## Risks

- **Stock-route rate-limit coupling.** `_apply_limit(router, limit)` wraps
  `route.endpoint` with `limiter.limit(...)` and refreshes `route.dependant.call`
  (spike-verified: 200,200,429). It depends on Starlette `APIRoute` internals; a
  fastapi/starlette bump could break it. Mitigated by the rate-limit pytest (429
  test on login) + a QA curl on register. If it ever breaks, the fallback is
  login-only limiting (Open Q2b).
- **`created_at` default.** The adapter's `create` sets only `{token, user_id}`; if
  the model lacks a working default, insert fails or `read_token`'s max-age compares
  against NULL. Mirror the library mixin's tz-aware Python `default` (not
  server-only) — covered by the refresh happy-path + expired tests.
- **Session commit inside strategies.** `SQLAlchemyAccessTokenDatabase.create/delete`
  **commit** the shared request session (rotation = destroy+write = two commits).
  Acceptable, but any future logic expecting a single transaction around a route
  must account for it. No partial-write risk in 1.1 (each route is single-purpose).
- **Migration ordering.** 0001 is the first real migration; `downgrade base` must
  drop both tables cleanly (FK order). Covered by the upgrade→downgrade→upgrade
  validation and the subprocess test fixture.
- **Refresh-token-as-Bearer.** The F6 structural guarantee is only as strong as
  "JWT backend only on the Authenticator." Pinned by
  `test_refresh_token_rejected_as_bearer`.

## Test plan (pytest-conventions — class-based, real Postgres, no vacuous tests)

Health + openapi drift tests stay. **backend-engineer owns these pytest cases** (in
`tests/`); items marked **[QA]** are curl/live-server integration for qa-engineer.

`tests/test_auth.py`:
- `TestRegister::test_returns_lean_user` — 201; body has `id/email/is_active` and
  **NOT** `is_superuser/is_verified` (pins the lean-schema + safe-register decision).
- `TestRegister::test_case_insensitive_duplicate_400` — register `foo@x.com` then
  `FOO@x.com` → 400 `REGISTER_USER_ALREADY_EXISTS` (pins §13.1 case-insensitive dedup,
  non-trivial).
- `TestLogin::test_returns_token_pair` — form-encoded happy path; 200, access +
  refresh + `token_type=="bearer"` (pins `TokenPair` shape + form contract).
- `TestLogin::test_bad_password_400` — 400 `LOGIN_BAD_CREDENTIALS`.
- `TestLogin::test_inactive_user_400` — inactive user via `db_session` → 400 (pins
  the is_active re-check that `authenticate` omits).
- `TestRefresh::test_rotates_and_revokes_old` — login → refresh (new pair, differs)
  → refresh again with the **old** token → 401 (happy path + rotation + reuse
  rejection, the security-critical contrast).
- `TestRefresh::test_expired_token_401` — direct-insert a `refresh_tokens` row with
  `created_at = now-40d` via `db_session` → `/auth/refresh` → 401 (max-age path).
- `TestRefresh::test_unknown_token_401` — garbage token → 401 (distinct branch:
  no DB row; same 401/detail proves the no-oracle contract).
- `TestLogout::test_revokes_token` — login → logout → refresh with that token → 401.
- `TestLogout::test_unknown_token_204` — unknown token → 204 (no 404 oracle;
  guards a deliberate security decision).
- `TestSecurity::test_refresh_token_rejected_as_bearer` — login, send `refresh_token`
  as `Authorization: Bearer` to `GET /users/me` → 401 (**F6 structural guarantee**).
- `TestForgotPassword::test_always_202` — known and unknown email both → 202
  (no oracle; also confirms reset router mounted).
- `TestRateLimit::test_login_429` — app built with `rate_limit_enabled=True` +
  `login_rate_limit="2/minute"`; 3rd `/auth/login` → 429 (slowapi wiring; slowapi
  checks before the body, so wrong-creds calls suffice — cheap).

`tests/test_users.py`:
- `TestUsersMe::test_returns_lean_user` — login → `GET /users/me` with access JWT →
  200 lean shape (protected-route auth wiring happy path).
- `TestUsersMe::test_unauthenticated_401` — no token → 401 (the one auth test for
  this router, per conventions).

**[QA] curl / live-server:** reset-password full flow (capture the WARNING-logged
token from server logs → `POST /auth/reset-password` → new password logs in);
Swagger "Authorize" against `/auth/login` works (S2 manual); `/auth/login` accepts
`application/x-www-form-urlencoded`; register spam → 429 (stock-route limit);
frontend-engineer sanity-reviews the regenerated auth surface in `schema.d.ts`.

## Contract regeneration (carry-forward)

Auth endpoints change the schema → drift gates go red until regenerated. After
implementation: run `pnpm openapi` (turbo: `@budget/api#openapi` writes
`apps/api/openapi.json`, then `@budget/api-client#generate` writes
`packages/api-client/src/generated/schema.d.ts`). **Commit BOTH artifacts
together.** `test_openapi_export.py` + the api-client `drift.test.ts` both fail until
then. Client-facing notes for 1.5 (architecture §10): `/auth/login` is the only
`application/x-www-form-urlencoded` request (needs a urlencoded bodySerializer);
FastAPI auto-names the form schema `Body_login_auth_login_post` (harmless); new
`OAuth2PasswordBearer` securityScheme + per-route `security`; error `detail` is
string-or-object (union); 429 body is `{"error": str}`.

## Root-file changes (I own root files — 0.1 §1.1)

Reviewed `package.json` and `turbo.json`: **no changes needed.**
`@budget/api#test`/`#lint`/`#typecheck`/`#openapi` inputs already glob `src/**`,
`tests/**`, `pyproject.toml`, `uv.lock`, `alembic/**`, `alembic.ini`, `openapi.json`
— the new migration, deps, and regenerated schema are already covered. The
`@budget/api-client#generate` → `#openapi` dependsOn chain already regenerates the
client. `.env.example` lives under `apps/api/` (not a repo-root file). No new script
or pipeline wiring required.

## Per-amendment / carry-forward table (report at /implement)

| Carry-forward | This task |
|---|---|
| Root-file ownership = backend-engineer (0.1 §1.1) | Owned; reviewed, no root changes needed |
| Both contract artifacts committed together | `openapi.json` + `schema.d.ts` in one commit after `pnpm openapi` |
| Per-amendment checklist in `/implement` report | Will enumerate each amendment + deviation |
| Exact-pin + `uv.lock` convention | `>=` floors in pyproject + regenerated `uv.lock`; transitive deps not pinned explicitly |
| Local test Postgres `:5443` via `TEST_DATABASE_URL` (committed `:5433`) | Honored in conftest + migration subprocess env |
| pyright strict on `src/`; ruff `E W F I UP B C4 SIM RUF ASYNC` | New modules conform; two documented `# type: ignore[arg-type]` (S1) |

## Acceptance criteria (runnable)

From `apps/api/` (test DB reachable; on this machine `TEST_DATABASE_URL=...:5443`):
- `uv sync` — resolves `fastapi-users[sqlalchemy]` + `slowapi`, updates `uv.lock`.
- `DATABASE_URL=<budget> uv run alembic upgrade head && uv run alembic downgrade base
  && uv run alembic upgrade head && uv run alembic check` — migration 0001 applies,
  reverses, and reports no diff.
- `uv run ruff check . && uv run ruff format --check .` — clean.
- `uv run pyright` — clean (only the two documented `# type: ignore[arg-type]`).
- `uv run pytest` (the `make test` equivalent — repo uses `pnpm test` /
  `uv run pytest`; **no Makefile exists**) — all pass, none skipped; health +
  openapi-drift + all auth/users tests green.
- From repo root: `pnpm openapi` then `git status` shows `apps/api/openapi.json` +
  `packages/api-client/src/generated/schema.d.ts` regenerated; `pnpm test` green
  (drift gates satisfied) once both are committed.

## Disagreements with architecture.md

None substantive. Two clarifications where architecture left wiring to the engineer
(§14) and one DDL nuance, all consistent with the doc's intent:
- **§8 rate knobs:** added `rate_limit_enabled` + per-route limit strings as Settings
  fields (not surfaced in `.env.example`) so tests can disable/shrink limits — §8
  already anticipates "fields exist because tests shrink them."
- **§13.6 stock-route limiting:** architecture §7 lists limits on all three
  unauthenticated routes but §14 leaves wiring to the engineer; the only clean
  mechanism for the two stock routes is post-decoration (Open Q2 / Risks).
- **§3 `refresh_tokens.created_at`:** use a tz-aware **Python** default (mirroring
  the library mixin `now_utc`) rather than server_default, because the adapter's
  `create` supplies no `created_at` and must have the value before the post-commit
  refresh; behaviourally identical, matches the primitive we're reusing.
