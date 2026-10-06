# Implementation Plan: web push reminders — B1 (API, FULL tier)

## Approach
architecture.md §1–§6 verbatim. Precedents reused: `recurring_jobs.materialize_due` (job shape), `fx_jobs` (no session
across outbound HTTP), `ai_gate` (gate), advisor (`_limiter_any.limit` + `stash_rl_user`), tokens (JWT-only). Two small
refinements + one security question → Open questions.

## Files — in implementation order
1. **Dep** — `cd apps/api && uv add 'pywebpush>=2.5,<3'`. Verified from the 2.5.0 wheel (read in scratchpad, not
   installed): pulls `requests`, `py-vapid` (→ `cryptography`), `http-ece`, AND `aiohttp` (for `webpush_async`, unused —
   §3 ratified `to_thread`). No `py.typed` → `# type: ignore` import + `Any` alias (apscheduler/slowapi precedent).
2. **`config.py`** — one commented block after recurring, per §2: VAPID trio (`""`, "ON ⇔ all three non-empty",
   formats named); `push_scheduler_enabled = True` (recurring gate paragraph); `push_reminder_hour_utc = 6` /
   `_minute_utc = 0` (MUST stay after the 00:30 materializer); `push_reminder_horizon_days = 1` (≥1, else charges
   family is always empty); `push_test_rate_limit = "5/minute"`.
3. **`models/push.py`** — `PushSubscription` (uuid `id` default uuid4; `user_id` FK CASCADE `index=True`; `endpoint`
   Text `unique=True`; `p256dh`/`auth` Text; `lang` String(2) + CHECK name `lang_valid`; `user_agent` String(255) NULL;
   `created_at`/`updated_at` `server_default=func.now()`); `PushReminderSend` (PK `user_id` FK CASCADE + `sent_on` Date,
   five SmallInteger counters `server_default=text("0")`, `created_at`). Export both in `models/__init__.py`.
4. **`alembic/versions/0015_push.py`** — rev `"0015"`, down `"0014"`, 0007 style, `op.f()` names as the convention
   yields (`uq_push_subscriptions_endpoint`, `ck_push_subscriptions_lang_valid`, `ix_push_subscriptions_user_id`,
   `fk_…_users_user_id`, `pk_…`). Downgrade: sends → ix → subscriptions. Docstring: pure DDL, no backfill/retention.
5. **`services/push_sender.py`** — `PushTarget(Protocol)` (`endpoint`, `p256dh`, `auth`); `SendOutcome(StrEnum)`;
   `PushSender(settings)`: `enabled`, `public_key -> str | None` (None when disabled), `async send(target, payload)`;
   constants `_TTL_SECONDS = 86400`, `_TIMEOUT_SECONDS = 10`. Skeleton below.
6. **`domain/push_digest.py`** — pure (below). It + `tests/test_push_digest.py` go into ruff `per-file-ignores`
   `RUF001/RUF003` (Cyrillic "Скоро" trips the homoglyph rule — advisor.py precedent).
7. **`services/recurring_reads.py`** — `read_upcoming_charges(session, user_id, *, today, through) ->
   list[UpcomingCharge]` (frozen dataclass = `UpcomingChargeRead`'s 8 fields): query + loop + `(due_on, rank)` sort moved
   verbatim from `routers/recurring.py:list_upcoming`; router keeps its docstring (it IS OpenAPI text) and maps 1:1.
   Existing `/recurring/upcoming` tests pin it; no new test.
8. **`services/push_jobs.py`** — `send_daily_reminders(sessionmaker, *, sender, horizon_days, today=None)`; flow below.
9. **`push_gate.py`** — `require_push_configured(request)`: `push_sender.enabled` false → 503 `PUSH_NOT_CONFIGURED`.
10. **`rate_limit.py`** — `push_test_limit_value()` beside `advisor_ask_limit_value`.
11. **`schemas/push.py`** — `PushConfigRead{enabled, public_key|None}`, `PushKeys{p256dh, auth}` (base64url pattern,
    max 256), `PushSubscriptionCreate{endpoint, keys, lang: Literal["ru","en"], user_agent: str|None ≤255}`,
    `PushSubscriptionRead{id, endpoint, created_at}`, `PushUnsubscribe{endpoint}`, `PushTestResult{sent, removed}`,
    `PushError{detail}`. Endpoint validation → Open question 1.
12. **`routers/push.py`** — each handler under `# MCP: no — <reason>` (config/subscribe/unsubscribe: "binds a browser
    device; meaningless without a browser"; test: "side effect on the user's devices an agent cannot observe").
    Dependency order `user → gate → session` (401 before 503).
    - `GET /config` — `current_active_user`, no gate, reads `request.app.state.push_sender`.
    - `POST /subscriptions` 201, `responses={503}` — UPSERT below, commit.
    - `POST /unsubscribe` 204 — `DELETE … WHERE endpoint = :e AND user_id = :me`, commit; no gate, no rowcount branch.
    - `POST /test` — `@_limiter_any.limit(push_test_limit_value, key_func=user_rl_key("push_test"),
      exempt_when=rate_limit_exempt)`, `user = Depends(stash_rl_user)`, gate, session; `responses={429, 503}`. Read own
      subs + profile language into plain `_Device`s → `commit()` (ends the read tx) → send `test_digest(lang)` per device
      (job's lang rule) → delete `gone` scoped by `user_id` → commit → `{sent: delivered, removed: gone}`.
13. **`app.py`** — `app.state.push_sender = PushSender(resolved)` beside `fx_fetcher`; mount `push.router,
    prefix="/push", tags=["push"], dependencies=[Depends(prime_rate_limit)]` (advisor mount does exactly this) before
    `pat_allowlist`; lifespan gate `fx or recurring or push` ("TWO features" comment → three); push block = one
    `CronTrigger(hour, minute, timezone="UTC")`, `misfire_grace_time=3600, coalesce=True`, kwargs `{sessionmaker,
    sender: app.state.push_sender, horizon_days}`; comment on why NO run-now job (§4). CORS untouched.
14. **`apps/api/.env.example`** — empty VAPID trio + the keygen one-liner as a comment.

## Code skeletons (tricky parts only)
```python
# push_sender.send — the ONE pywebpush call site
try:
    await asyncio.to_thread(_webpush,  # Any alias of pywebpush.webpush
        subscription_info={"endpoint": t.endpoint, "keys": {"p256dh": t.p256dh, "auth": t.auth}},
        data=json.dumps(payload, ensure_ascii=False), vapid_private_key=self._private_key,
        vapid_claims={"sub": self._subject},  # FRESH per call: webpush() MUTATES it (sets aud of THIS endpoint + exp)
        ttl=_TTL_SECONDS, timeout=_TIMEOUT_SECONDS)  # webpush() default timeout=None → requests never times out
except WebPushException as exc:
    status = exc.response.status_code if exc.response is not None else None  # None: key/encoding errors
    if status in (404, 410): return SendOutcome.gone
    logger.warning("push failed (%s) host=%s: %s", status, _host(t.endpoint), exc.message); return SendOutcome.failed
except Exception as exc:  # requests timeouts/conn errors are NOT wrapped by pywebpush; never-raises contract
    logger.warning("push failed host=%s: %r", _host(t.endpoint), exc); return SendOutcome.failed
return SendOutcome.delivered
# log the HOST only: the full endpoint is a bearer capability for the device
```
```python
claimed = await s_a.scalar(pg_insert(PushReminderSend).values(user_id=uid, sent_on=run_date)
    .on_conflict_do_nothing(index_elements=["user_id", "sent_on"]).returning(PushReminderSend.user_id))
await s_a.commit()                     # committed BEFORE any send (§4 Change)
if claimed is None: continue          # another/earlier run owns today
stmt = pg_insert(PushSubscription).values(user_id=me, endpoint=…, p256dh=…, auth=…, lang=…, user_agent=…)
stmt = stmt.on_conflict_do_update(index_elements=[PushSubscription.endpoint], set_={"user_id": stmt.excluded.user_id,
    "p256dh": stmt.excluded.p256dh, "auth": stmt.excluded.auth, "lang": stmt.excluded.lang,
    "user_agent": stmt.excluded.user_agent, "updated_at": func.now()})
row = (await session.execute(stmt.returning(PushSubscription.id, PushSubscription.endpoint,
                                             PushSubscription.created_at))).one()  # conflict keeps the ORIGINAL id
```
**Job flow**: `not sender.enabled` → `logger.info`, return. Probe session (closed): `SELECT DISTINCT s.user_id FROM
push_subscriptions s JOIN users u ON u.id = s.user_id WHERE u.is_active`. Per user, one broad `try/except Exception →
logger.warning(uid)`:
- **Session A** — claim, commit.
- **Session B (read-only, closed before any send)** — subs → `_Device` dataclasses; `Profile.language` scalar (no
  self-heal); `read_upcoming_deadlines` → `GoalItemRef(goal_id, goal_name, item_name)`; `read_upcoming_charges` → names;
  deposits `SELECT name … archived IS FALSE AND term_end BETWEEN :today AND :through ORDER BY term_end, created_at`;
  `through = today + timedelta(days=horizon_days)`.
- **No session** — nothing due → no sends. Else digest per language (profile language if set, else device `lang`;
  lazy `dict[lang, Digest]`), `await sender.send` sequentially.
- **Session C (write)** — `DELETE` gone `WHERE user_id = uid AND endpoint IN (…)`; `UPDATE` claim's five counters
  (zeros when nothing due); commit. `failed` changes nothing.

**Digest** — `GoalItemRef`, `DigestInput(goal_items, charges, deposits, lang, on: date)`, `Digest(title, body, url,
tag)` + `to_payload()`. No money member anywhere. Names in order: goal items as `"{goal_name}: {item_name}"`, charges,
deposits. Body = first 3 joined `", "`; more → RU `"{names} и ещё {n}"`, EN `"{names} and {n} more"`. RU needs NO plural
forms by construction: the count is never followed by a noun. Titles RU `"Скоро"`, EN `"Coming up"`. `test_digest`: RU
`"Уведомления включены"` / `"Это пробное уведомление."`, EN `"Notifications are on"` / `"This is a test
notification."`, url `/settings`, tag `budget-test`. URL: only goal items → `/goals/<id>` (one goal) else `/goals`; only
charges → `/recurring`; only deposits → `/deposits`; ≥2 families → `/transactions` (all exist in `apps/web/src/routes`).
Tag `budget-reminder-<on.isoformat()>`.

## Tests (15 new + 2 edits) — `pytest-conventions` skill loaded first
- **helpers.py**: `FakePushSender(PushSender)` (fx `_NoNetworkFetcher` precedent, no `super().__init__`): `enabled`,
  `public_key`, scripted `outcomes: dict[endpoint, SendOutcome]` (default delivered), recorded `sent`.
- **conftest.py**: `setdefault("push_scheduler_enabled", False)` in `_make` AND in the four other app-building fixtures
  (`test_advisor.py`, `test_receipts.py`, `test_goal_item_files.py`, `test_health.py`) — else each starts a scheduler.
  New `make_push_client(sender=None, **overrides)` fixture (advisor-fixture shape, VAPID set by default).
- **test_push_api.py (5)**: (1) unsubscribe own → gone, foreign → intact, both 204 identical [th.1]; (2) re-POST → one
  row, same id, keys/lang updated [th.2]; (3) other user's POST rebinds `user_id` [th.2]; (4) VAPID unset vs set: config
  flag/key, subscribe+test 503 `PUSH_NOT_CONFIGURED`, unsubscribe 204, unauth test on keyless app → 401 [th.3];
  (5) `/test` hits own devices only, gone deleted / failed kept, `{sent, removed}`, 2nd call at 1/minute → 429 [th.5].
- **test_push_jobs.py (5)**, direct call, fixed `today=`, real Postgres: (1) two concurrent runs (`gather`) + rerun →
  one push per device, one claim row [th.4]; (2) gone deleted, failed kept, counters written [th.5]; (3) profile lang
  wins; device lang when profile NULL [th.7]; (4) money-bearing rows of all three families (+ a charge booked today and
  a deposit at today+2 that must NOT appear) → names present, no amount in payload, url `/transactions`, counters 1/1/1;
  user with nothing due → zero-counter claim, no push [th.6]; (5) inactive user / disabled sender → no sends, no claims.
- **test_push_digest.py (2, pure)**: URL rule over the five cases; 3 names verbatim vs 5 → "и ещё 2"/"and 2 more" + tag.
- **test_scheduler_wiring.py**: existing combos pass `push_scheduler_enabled=False` ("neither" stays None); +1 push-only
  test: one Cron at configured UTC slot, grace 3600, coalesce, kwargs keys, ZERO DateTrigger jobs [th.8].
- **test_pat_auth.py**: 4 `/push/*` pairs into `NEVER_PAT`; derived allowlist stays 38 [th.9].
- If OQ1 lands: +1 api test (non-https / non-push-service endpoint → 422).

## Contract
`pnpm openapi` (root) regenerates `apps/api/openapi.json` + `packages/api-client/src/generated/schema.d.ts`, one
commit. `tests/test_mcp_tools.py` snapshot stays UNCHANGED (no `@mcp_tool`/`@pat_reachable` added).

## Gates
`cd apps/api && uv run ruff check . && uv run ruff format --check . && uv run pyright && uv run pytest` (= the
`@budget/api` lint/typecheck/test scripts); `alembic check` against `budget_test` only (`upgrade head` → `check` →
`downgrade base`, never the dev DB); `pnpm openapi`; `pnpm turbo typecheck test --filter=@budget/api-client
--filter=@budget/mobile --filter=@budget/web`. Docs same pass: backend.md (router/services/domain/0015/Scheduler/
`PUSH_NOT_CONFIGURED`/never-set 19→23), infra.md (`PUSH_SCHEDULER_ENABLED=false` third flag).

## Open questions (senior-lead)
1. **SSRF via `endpoint`** (architecture silent): the server POSTs to a user-supplied URL daily and on `/test`.
   Proposed: validator — `https` only + host-suffix allowlist (`fcm.googleapis.com`, `.push.services.mozilla.com`,
   `.push.apple.com`, `.notify.windows.com`) → 422. Minimum fallback: https-only.
2. Job session split B (read, closed) + C (write) instead of one session across sends — fx_jobs rule; same behaviour.
3. `DigestInput.on: date` added (the tag needs the date; §5 lists none).

## Risks
- `on_conflict_*` + `.returning()` via `AsyncSession`: DO NOTHING → `scalar()` None (concurrency test); DO UPDATE must
  return the ORIGINAL id (api test 2).
- `to_thread` in the scheduler loop: default pool is ample; the explicit 10 s timeout keeps a hung service from pinning
  a thread. `vapid_claims` mutation: a shared dict silently breaks every push service but the first.
- Alembic chain `0014 → 0015`; conftest `downgrade base` at teardown fails the suite on a broken downgrade.
- Claim-before-send: a crash after the claim loses the day by design — no test may expect a retry.
- `is_active` lives only in the probe; `/test` relies on `current_active_user`.
- Recurring extraction: `ORDER BY created_at, id` + `(due_on, rank)` sort verbatim; router docstring untouched.
- VAPID rotation: old subs answer 403 → `failed`, kept until the web re-subscribes with the new key (web-plan note).
