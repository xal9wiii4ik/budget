# Architecture Plan: web push reminders (5.2)

## Context
A daily server-side digest over three "upcoming" families the API already computes for widgets, delivered to browser devices via Web Push/VAPID. Architectural surface: two tables (0015), a third scheduler job behind its own gate, one external-integration seam (`pywebpush`), one new router, contract pair. Everything below ratifies the senior-lead recommendations A–H unless marked **Change**.

## §1 Tables + migration `0015_push.py` (models in `models/push.py`, two classes)
`push_subscriptions` — one row per browser device.
- `id` uuid PK; `user_id` uuid FK users ON DELETE CASCADE NOT NULL, `ix_push_subscriptions_user_id`.
- `endpoint` TEXT NOT NULL, UNIQUE (`uq_push_subscriptions_endpoint`). Global, not per-user, by design: a device that changed hands re-POSTs the same endpoint and the UPSERT moves `user_id` — the rebind IS the conflict arm. Push endpoints are ~200–400 chars, far under the btree limit; no length cap.
- `p256dh` TEXT NOT NULL, `auth` TEXT NOT NULL (the browser's keys, opaque base64url).
- `lang` String(2) NOT NULL, CHECK `lang IN ('ru','en')` (`ck_push_subscriptions_lang_valid`; same literal as `profiles.language_valid`).
- `user_agent` String(255) NULL — support-only (no list endpoint in scope): the one way to tell rows apart when reading the table by hand.
- `created_at`, `updated_at` timestamptz `server_default now()`; `updated_at` rewritten by the UPSERT.

`push_reminder_sends` — the per-user-per-day CLAIM, the idempotency unit.
- `user_id` uuid FK users CASCADE, `sent_on` DATE, PK `(user_id, sent_on)`.
- `goal_items`, `charges`, `deposits`, `delivered`, `removed` SmallInteger NOT NULL `server_default 0` — plain ints, not jsonb: queryable in SQL by support, no shape to drift.
- `created_at` timestamptz.
- No retention job: a row is ~50 bytes and the probe only touches today's date; prune by hand if it ever matters.

Per-day claim over per-item records, ratified: the product rule is ONE notification per user per run, so the unit of "already done" is the day, not the item. Documented consequence: an item that becomes due after 06:00 UTC waits for tomorrow's run. Per-item rows would buy intra-day pushes the product does not ask for and a second notification per day it explicitly forbids.

Migration: pure DDL, symmetric downgrade (drop sends → drop sub index → drop subscriptions), 0007 style with `op.f()` names. No backfill (new feature). Revision `0015`, down `0014`.

## §2 Settings (`config.py`, all with defaults so conftest/openapi_export construct with no env)
- `vapid_public_key: str = ""` (base64url uncompressed P-256 point — what the browser's `applicationServerKey` needs), `vapid_private_key: str = ""` (base64url raw key, the `py-vapid` output form pywebpush accepts as a string), `vapid_subject: str = ""` (`mailto:` claim). Feature ON ⇔ all three non-empty; `.env.example` documents the trio, the owner generates them.
- `push_scheduler_enabled: bool = True`; conftest `_make` adds `overrides.setdefault("push_scheduler_enabled", False)` next to the fx/recurring lines (tests/conftest.py ~161); live QA servers export `PUSH_SCHEDULER_ENABLED=false` (docs/infra.md gains the third flag).
- `push_reminder_hour_utc: int = 6`, `push_reminder_minute_utc: int = 0`, `push_reminder_horizon_days: int = 1`, `push_test_rate_limit: str = "5/minute"`.
- NOT a setting: push TTL (constant `86400` in the sender — a reminder older than its day is stale), urgency, web base URL (payload URLs are origin-relative, §5).

## §3 Sender seam — `services/push_sender.py`
- `class SendOutcome(StrEnum): delivered | gone | failed`; `class PushSender` with `__init__(settings)`, `enabled` property (trio non-empty), `public_key` passthrough, `async send(sub, payload: dict) -> SendOutcome`. `sub` is any object with `endpoint/p256dh/auth` (a `Protocol`, so the fake needs no ORM row).
- Real impl: `asyncio.to_thread(webpush, subscription_info={endpoint, keys:{p256dh, auth}}, data=json.dumps(payload), vapid_private_key=..., vapid_claims={"sub": subject}, ttl=86400)`. `WebPushException` whose `response.status_code in (404, 410)` → `gone`; any other exception → `failed` + `logger.warning` (row kept — a 5xx at the push service is not a dead device). Never raises.
- Constructed once in `create_app`: `app.state.push_sender = PushSender(resolved)` beside `fx_fetcher`; routes read it off `request.app.state`, the job gets it via kwargs, pytest swaps a recording fake (`outcomes` list + scripted per-endpoint results) — tests never touch the network.

## §4 Job — `services/push_jobs.py:send_daily_reminders(sessionmaker, *, sender, horizon_days, today=None)`
Shape = `recurring_jobs.materialize_due` (never raises, probe session closed before work, one session per user, broad per-user except → warning). `today` computed per run, not bound in kwargs (D5 precedent).
1. If `not sender.enabled`: one `logger.info`, return. The job is registered whenever the gate is on, so a keyless server is harmless and `test_scheduler_wiring` can assert registration without keys.
2. Probe: `SELECT DISTINCT s.user_id FROM push_subscriptions s JOIN users u ON u.id = s.user_id AND u.is_active`.
3. Per user, session A: `INSERT INTO push_reminder_sends (user_id, sent_on) VALUES (:uid, :today) ON CONFLICT DO NOTHING RETURNING user_id`; no row → skip user; **commit immediately**. **Change** vs "claim in the same transaction as the send": the claim is committed BEFORE any send, so a crash between send and commit can only LOSE a day's digest, never duplicate it (a duplicate push is the failure the product named; a missed day is not). Two concurrent runs (coalesced misfire + cron on a slow host) race on the PK and exactly one proceeds. Claim ALWAYS, even when nothing turns out to be due: "the job evaluated this user today" is then a fact support can see, and the one-evaluation-per-day rule has no exceptions.
4. Session B (same user): load subscriptions; `profile.language` by plain select (no self-heal, the recurring-job rule); gather with `through = today + horizon_days`:
   - goal items: `read_upcoming_deadlines(session, uid, today=today, through=through)` — already excludes archived goals and judges a node by its reminder date when it has one; the job keeps only `goal_id/goal_name/item_name`.
   - charges: the exact `GET /recurring/upcoming` loop (unpaused templates, `upcoming_due_dates(..., watermark, today, end_date, through)`), names only. Pull the loop into a small `services/recurring_reads.py:read_upcoming_charges(session, uid, *, today, through)` and have the router call it — one definition, as B4 demands.
   - deposits: `SELECT name FROM deposits WHERE user_id=:uid AND archived IS FALSE AND term_end BETWEEN :today AND :through ORDER BY term_end` — the `depositDeadlines.ts` rule, inclusive both ends.
5. Empty across all three → update counts (zeros), commit, next user. Else build the digest (§5) per distinct language among the user's devices (profile language wins; else the device's `lang`), `await sender.send` per device sequentially (a user has a handful), collect outcomes; `DELETE` the `gone` rows; `UPDATE` the claim's five counters; commit. A `failed` outcome changes nothing.
Horizon (ratified, C): window `[today, today+1]`, UTC like every job. 30 days would push daily for a month about one item. Consequence to know: a goal reminder lands twice — on D-1 and D; acceptable, and `push_reminder_horizon_days=0` is the knob if it grates. Load-bearing ordering: materialize runs 00:30, push 06:00, so today's charges are already BOOKED and fall out of `upcoming_due_dates` by its watermark floor — the recurring family is effectively "charges due tomorrow", and with horizon 0 it would always be empty. Keep the horizon ≥1 and the cron after 00:30.
Scheduler wiring (app.py lifespan): the scheduler object is built if ANY of the three gates is on; push job = `CronTrigger(hour, minute, UTC)`, `misfire_grace_time=3600, coalesce=True`, kwargs `{sessionmaker, sender: app.state.push_sender, horizon_days}`. **No boot run-now job** (decision): a restart must not push; the claim would make it idempotent, but a late-evening restart after a missed 06:00 would deliver a stale digest at 23:00. A host asleep past the grace hour simply skips the day.

## §5 Digest + privacy — pure `domain/push_digest.py`
- Input `DigestInput(goal_items: list[GoalItemRef(goal_id, goal_name, item_name)], charges: list[str], deposits: list[str], lang: Literal["ru","en"])` → `Digest(title, body, url, tag)`. The input dataclass has NO amount/currency member — that is the privacy guarantee, by construction; one test asserts the rendered text of a digest built from money-bearing rows contains no digits of the amounts.
- Text: day-agnostic ("Coming up" / "Скоро"), since charges are tomorrow's and reminders may be today's; body = up to 3 names + "and N more"; RU/EN dictionaries live here.
- URL (origin-relative path; the SW resolves it, so no base-URL setting): all rows in one family → `/goals/<goal_id>` when one goal else `/goals`; `/recurring`; `/deposits`; mixed → `/transactions` (both widgets). The web plan verifies these four paths against docs/web.md routes before B1 lands.
- `tag = "budget-reminder-<YYYY-MM-DD>"` — the OS collapses a same-day duplicate per device.
- `test_digest(lang) -> Digest` here too (title/body "test notification", url `/settings`, tag `budget-test`): every string a user sees in a push comes from this one module.
- Payload JSON = `{title, body, url, tag}`; nothing else.

## §6 Routes — `routers/push.py`, prefix `/push`, tag `push`, `schemas/push.py`
All JWT-only via `current_active_user` from `auth.py` (a PAT must never register devices); mounted with `Depends(prime_rate_limit)` (the `/test` limiter needs the contextvar). Gate `require_push_configured` lives in `push_gate.py` next to `ai_gate.py` (same shape, reads `app.state.push_sender.enabled`, 503 `PUSH_NOT_CONFIGURED`); declared AFTER the user dependency so 401 precedes 503 (advisor precedent).
- `GET /push/config` → 200 `PushConfigRead{enabled: bool, public_key: str|null}`; no gate — the honest flag the web explains with.
- `POST /push/subscriptions` body `PushSubscriptionCreate{endpoint: str, keys: {p256dh, auth}, lang: ru|en, user_agent?: str (max 255, web truncates)}` → 201 `PushSubscriptionRead{id, endpoint, created_at}`. `INSERT … ON CONFLICT (endpoint) DO UPDATE SET user_id, p256dh, auth, lang, user_agent, updated_at=now() RETURNING` — upsert and rebind are one statement; re-POST is idempotent (same id back). Gated (503 when VAPID unset).
- `POST /push/unsubscribe` body `{endpoint}` → 204 ALWAYS: `DELETE WHERE endpoint=:e AND user_id=:me`; foreign/missing delete nothing, byte-identical. NOT gated — removing a row needs no keys. POST-with-body rather than DELETE: openapi-fetch and DELETE bodies do not mix.
- `POST /push/test` → 200 `PushTestResult{sent: int, removed: int}`; gated; `@_limiter_any.limit(push_test_limit_value, key_func=user_rl_key("push_test"), exempt_when=rate_limit_exempt)` + `stash_rl_user` (advisor construction). Sends `test_digest(lang)` to every own device; `gone` rows deleted; zero devices → `{0,0}` (the web already knows it has no local subscription).
- Error codes: `PUSH_NOT_CONFIGURED` (503), `RATE_LIMITED` (429); 422s = Pydantic only, no `_UNPROCESSABLE` override.
- MCP: NO on all four, `# MCP: no — <reason>` comments: device binding is meaningless without a browser (config/subscribe/unsubscribe); a test push is a side effect on the user's devices with no interface for an agent to see. Add the four pairs to `NEVER_PAT` in `tests/test_pat_auth.py`; the derived allowlist count stays 38.
- CORS: GET/POST only — nothing to add to `allow_methods` (G).
- Contract: `pnpm openapi` regenerates both artifacts in B1, one commit (H).

## §7 Web contract notes (input to the frontend plan)
- Bootstrap: `GET /push/config`; `enabled=false` → the Settings section explains "server not configured" and renders no button. iOS: only inside a Home-Screen install, after a tap.
- Subscribe: `PushManager.subscribe({userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(public_key)})` → POST the `toJSON()` endpoint/keys + current UI `lang` + truncated `navigator.userAgent`. Re-POST on every app start while subscribed is safe (idempotent upsert) and is how a language change or a key rotation reaches the server.
- Unsubscribe: browser `subscription.unsubscribe()` then `POST /push/unsubscribe`; order does not matter, 204 either way.
- SW: `push` handler parses `{title, body, url, tag}` and calls `showNotification(title, {body, tag, data:{url}})`; `notificationclick` focuses an open client at `url` or `clients.openWindow(url)`. `url` is a path; resolve against `self.location.origin`.
- A subscription the push service has killed disappears server-side on the next job/test; the client should re-subscribe when `pushManager.getSubscription()` is null.

## §8 Test themes (9)
1. unsubscribe scoping/no-oracle: own → gone, foreign → untouched, both 204 byte-identical.
2. subscribe upsert + rebind: same endpoint twice → one row, same id; another user's POST moves `user_id`.
3. VAPID-unset honesty: config `enabled=false`, subscribe/test → 503 `PUSH_NOT_CONFIGURED`, unsubscribe still 204.
4. job idempotency: two runs same `today` → one send per device, one claim row.
5. gone → row deleted (job and `/test`), failed → row kept.
6. payload has no amounts (digest built from rows with amounts; text free of them) + URL rule per family/mixed.
7. language: profile wins over device lang; device lang used when profile NULL.
8. scheduler wiring: push job registered with the gate on, absent with it off (extend `test_scheduler_wiring.py`).
9. PAT never-set: the four pairs refused (extend `NEVER_PAT`).

## §9 Open questions
None that block. The single either/or (horizon 1 → goal reminders mentioned on D-1 and D) is decided for 1 above, with the setting as the escape hatch.

## What this does NOT decide
Exact RU/EN strings; the web Settings layout; whether `/push/test` should mirror the real digest instead of a fixed text (fixed text chosen, a one-line change if PM prefers).
