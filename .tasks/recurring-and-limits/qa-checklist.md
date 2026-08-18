# QA Checklist: recurring-and-limits (roadmap 5.3 recurring + 5.4 limits; backend. Web → web-qa, mobile FROZEN)

**SCOPE QA STRATEGY, mapped by subtask.** Grooming artifact — nothing is executed
now. Each block runs at the **/test stage of its own subtask** (B1a's checks at
B1a's /test, etc.). I do not write test code and I do not fix backend code:
failures are captured and escalated to senior-lead.

| Subtask | Tier (plan) | Section B format |
|---|---|---|
| **B1a** DDL + models + pure math | FULL | detailed, but short — structure only, no runtime surface |
| **B1b** extraction + job + wiring | FULL | detailed — the job is exercised by **direct call** with a controlled `today` |
| **B2** `/recurring` CRUD + attribution | FULL | detailed — exact curl, hand-pinned `next_due_on` |
| **B3** `/limits` | FULL (argued) | detailed — hand-pinned `spent_minor` in two currencies |

**Split rule.** pytest (Section A, backend-owned) keeps: the pure clamp/weekday/
window math, the watermark algebra, DB CHECK arms, snapshot decision-table arms,
user scoping, DTO validation, the scheduler-gate matrix. My live layer owns what
an in-process suite structurally cannot prove: the real HTTP wire (401 walls, 422
packs, the exact JSON keys the web is keyed on), the **job running against the
real live database through the app's own sessionmaker**, the cross-feature seams
nobody's pytest touches (materialized rows counting toward a category limit;
`recurring_template_id` surviving the LIST serializer), contract live-vs-committed,
and the two order-dependent lifecycles (materialize → edit → pause → unpause →
delete; PUT → GET → DELETE).

**Case-count note.** The brief says "39 numbered pytest cases"; the plan actually
numbers **41** (B1a 8 · B1b 11 · B2 13 · B3 9). The audit below covers all 41.

---

# CFG / environment strategy (binding for every TC below)

## CFG-J — the materialization job at /test: DIRECT CALL, never a live scheduler

The job is invoked by a one-off python process that builds the **app's own**
engine + sessionmaker from `apps/api/.env` (→ live DB `budget` @ **5443**) and
awaits `materialize_due(sessionmaker, today=<controlled date>)`. `today` is a
**parameter**, never a clock mock, never a frozen kwarg — which is exactly the
signature the plan specifies (B1b) and the reason it exists.

The runner lives in the **scratchpad**, never in the repo (root-file ownership;
the git tree must be byte-identical before and after my session):

```bash
export API=/Users/nikitazaretski/work/budget/apps/api
export SCRATCH=<session scratchpad>
cat > $SCRATCH/materialize.py <<'PY'
import asyncio, sys
from datetime import date
from budget_api.config import get_settings
from budget_api.db import build_engine, build_sessionmaker
from budget_api.services.recurring_jobs import materialize_due

async def main(today: date) -> None:
    engine = build_engine(get_settings())          # reads apps/api/.env -> 5443/budget
    try:
        await materialize_due(build_sessionmaker(engine), today=today)
    finally:
        await engine.dispose()

asyncio.run(main(date.fromisoformat(sys.argv[1])))
PY
run_job() { (cd $API && uv run python $SCRATCH/materialize.py "$1"); echo "exit=$?"; }
```

Rules that make this honest:

1. **Exit code and stderr are evidence.** `materialize_due` never raises (D5), so
   `exit=0` is necessary but not sufficient — every run's stderr is captured and
   inspected: a `recurring materialization failed for …` warning on a template I
   did not deliberately poison is a **STOP**, and the cap warning (TC-B1b-7) must
   be *present* where the design promises it.
2. **The job is GLOBAL — it has no user filter.** Before every run I take a
   census: `SELECT id, user_id, last_materialized_on, paused FROM
   recurring_templates`. If any row belongs to a user outside this run's
   throwaway pair → **STOP-and-ask** (Q-3): a controlled *future* `today` would
   otherwise write future-dated money rows into someone else's history.
3. **`today` may be in the future** (needed for the leap-February clamp pin,
   TC-B1b-6). Those rows are future-dated transactions on a throwaway user only,
   deleted at cleanup. Covered by Q-3.
4. **No scheduler on 8010, ever.** The standing server runs
   `FX_SCHEDULER_ENABLED=false RECURRING_SCHEDULER_ENABLED=false`. The one
   exception I *propose* (Q-1) is CFG-S2 below, on a different port, killed
   immediately.

## CFG-S — scheduler gate discipline (O-11 vs the binding env rule)

| Cfg | Server | Purpose | Gating? |
|---|---|---|---|
| **CFG-S1** (default, all TCs) | 8010, `FX_SCHEDULER_ENABLED=false`, `RECURRING_SCHEDULER_ENABLED=false` | every functional TC; `app.state.scheduler is None` | YES |
| **CFG-S2** (**proposed**, Q-1) | **8011**, `RECURRING_SCHEDULER_ENABLED=true`, `FX_SCHEDULER_ENABLED=false`, `RECURRING_MATERIALIZE_HOUR_UTC`/`_MINUTE_UTC` set ≈2 min ahead of real UTC, one due template on a throwaway user | O-11: the **unconditional boot run-now** fires and materializes exactly once, and the **cron** fires ~2 min later and is a no-op (idempotency under the real scheduler). Server killed straight after. | senior-lead's call |

O-11 (plan) asks for a live scheduler proof; the task env says no live scheduler
at /test. CFG-S2 is the smallest reconciliation: a separate, short-lived process
on a separate port, no FX job, no external I/O, one throwaway template. If it is
not authorized, TC-B1b-10 is recorded 🚫 **blocked-non-gating** and the wiring
rests on pytest B1b-11 (which needs GAP-6 fixed first).

## CFG-R — rates are a READ-ONLY fixture (binding)

**No INSERT, UPDATE or DELETE on `exchange_rates` in this scope.** The canonical
table (6 directed pairs, ~2282 rows at the currencies-goals handover) already
carries *different* rates on different dates, which is all the due-date-vs-run-date
contrast needs. Every converted number below is **read from the live table by psql
at run time and hand-computed**, never hardcoded from this document:

```bash
psql_q() { PGPASSWORD=budget psql -h localhost -p 5443 -U budget -d budget -tAc "$1"; }
psql_q "SELECT as_of_date, rate FROM exchange_rates WHERE base='BYN' AND quote='RUB' AND as_of_date IN ('2026-06-01','2026-07-01','2026-08-01') ORDER BY 1"
```
Observed at grooming (2026-08-18): `2026-06-01 → 25.85716502`, `2026-07-01 →
26.74941151`, `2026-08-01 → 27.30449978`. With `amount_minor = 10000 BYN` and
base RUB (both exponent 2, ROUND_HALF_UP at the single `convert_minor` quantize)
those are **258572 / 267494 / 273045** — three *different* numbers, which is what
makes the per-date rate pin non-vacuous.

- **BYN** = the rated foreign currency (stored `BYN→RUB` direct, no inversion).
- **GBP** = the rateless currency — verify `SELECT count(*) FROM exchange_rates
  WHERE base='GBP' OR quote='GBP'` is **0**; if not, substitute another unrated
  ISO code and record the substitution.
- Row count and pair set are recorded at PC-C and re-verified at cleanup: any
  delta means something in this scope wrote to the rate table → **STOP**.

## CFG-P — base-currency switching (no API exists)

There is **no endpoint** that changes `profiles.base_currency` (verified:
`/users/me` PATCH takes `{email?, password?}` only; the register hook seeds
`RUB`). The D15 mismatch/re-stamp pin therefore needs
`UPDATE profiles SET base_currency='USD' WHERE user_id=:throwaway` by psql —
a row *this run created*, never a fixture user. Same for the profile-less arm
(`DELETE FROM profiles WHERE user_id=:throwaway`). Authorization: **Q-2**.

## CFG-C — cleanup discipline (run at the end of EVERY subtask's /test)

1. `DELETE FROM users WHERE email LIKE 'qa_rl_%'` — cascade takes profiles,
   categories, transactions, recurring_templates, category_limits.
2. Orphan check, all zero: `SELECT count(*) FROM recurring_templates`,
   `… FROM category_limits`, and `SELECT count(*) FROM transactions WHERE
   recurring_template_id IS NOT NULL`.
3. `exchange_rates` row count + pair set **byte-equal** to the PC-C snapshot.
4. Ports 8010 (and 8011 if CFG-S2 ran) free; `git status --porcelain` at the repo
   root identical to its pre-QA state; scratchpad runner not in the repo.

---

# Preconditions

### PC-A — live API on 8010, DB at head — STOP rule
```bash
export BASE=http://localhost:8010
curl -s -o /dev/null -w '%{http_code}\n' $BASE/health && curl -s $BASE/health   # 200 {"status":"ok","database":"ok"}
```
Started by QA: `cd $API && FX_SCHEDULER_ENABLED=false RECURRING_SCHEDULER_ENABLED=false uv run uvicorn budget_api.app:create_app --factory --port 8010`.
If the live DB is behind head → `uv run alembic upgrade head` (env setup). From
B1a onward, migration `0006` **must** be applied; a *pending* migration at B1b/B2/B3
is a STOP-and-report. Not 200 → **STOP**.

### PC-B — two throwaway users, tokens, categories
Per the 1.3/1.4/stats-advisor construction: form-encoded login (`username` =
email), unique per-run emails on `@example.com` (`.test` is rejected by
registration).
```bash
export RUN=$(date +%s); export PW="password123"
export EMAIL_A="qa_rl_a_${RUN}@example.com"; export EMAIL_B="qa_rl_b_${RUN}@example.com"
# register A and B, login, capture TOKEN_A/TOKEN_B, A_ID/B_ID (GET /users/me)
export A_EXP=$(curl -s -X POST $BASE/categories -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' -d '{"name":"qa-exp","kind":"expense"}' | jq -r '.id')
export A_EXP2=$(… '{"name":"qa-exp2","kind":"expense"}' …)      # second limited category
export A_EXP3=$(… '{"name":"qa-exp3","kind":"expense"}' …)      # spending, NO limit
export A_INC=$(… '{"name":"qa-inc","kind":"income"}' …)
export A_ARCH=$(… '{"name":"qa-arch","kind":"expense"}' … )      # then PATCH archived:true
export SYS_EXP=$(curl -s $BASE/categories -H "Authorization: Bearer $TOKEN_A" | jq -r '[.[]|select(.kind=="expense" and .is_system==true)][0].id')   # shared system category (`is_system` verified in the committed CategoryRead contract)
```
Base currency of both users is **RUB** (`DEFAULT_BASE_CURRENCY`) — assumed by
every pinned number. STOP if any token/id is empty.

### PC-C — rate + census snapshot (read-only)
```bash
psql_q "SELECT count(*) FROM exchange_rates"                       # record N_RATES
psql_q "SELECT base,quote,count(*) FROM exchange_rates GROUP BY 1,2 ORDER BY 1,2"   # record the 6 pairs
psql_q "SELECT count(*) FROM exchange_rates WHERE base='GBP' OR quote='GBP'"        # MUST be 0
psql_q "SELECT id,user_id FROM recurring_templates"                # MUST be empty (or only this run's users) — else STOP, Q-3
```

### PC-D — the CFG-J runner (B1b onward) — see CFG-J.

### PC-E — template seeding before B2 exists
At **B1b's /test there is no `/recurring` API yet** (it ships in B2). Templates are
inserted by psql, matching the D2 column list:
```bash
psql_q "INSERT INTO recurring_templates (id,user_id,name,amount_minor,kind,currency,category_id,merchant,note,interval_unit,day_of_month,weekday,end_date,paused,last_materialized_on,created_at)
        VALUES (gen_random_uuid(),'$A_ID','qa-byn',10000,'expense','BYN','$A_EXP','qa-merch','qa-note','month',1,NULL,NULL,false,'2026-05-31',now())"
```
From B2 onward templates are created **through the API** and psql is used only to
read back off-wire state (`last_materialized_on`) and to rewind watermarks for
the catch-up arms.

---

# Section A — pytest test cases (owned by backend-engineer)

**I do not restate the plan's lists.** They are numbered in `plan.md` and are the
contract for Section A:

| Subtask | pytest cases | Files |
|---|---|---|
| **B1a** | plan **B1a-1..7** (pure recurrence math), **B1a-8** (DDL CHECK arms) | `tests/test_recurrence.py`, `tests/test_recurring_model.py` |
| **B1b** | plan **B1b-1..10** (job behaviour), **B1b-11** (scheduler gate matrix) | `tests/test_recurring_jobs.py`, `tests/test_scheduler_wiring.py`; `tests/test_transactions.py` unmodified is O-6's guard |
| **B2** | plan **B2-1..13** (CRUD, projection, PATCH matrix, SL-A/B/C pins, attribution) | `tests/test_recurring_api.py`, `tests/test_transactions.py` |
| **B3** | plan **B3-1..9** (upsert, base-switch stamp, category rules, bounds, fold, unconverted, window, scoping) | `tests/test_limits.py` |

**Cross-check verdict: the lists are strong** — nearly every case carries an
explicit contrast arm, and the three riskiest designed behaviours (per-template
atomicity, the SL-A `max()`, SL-B server-managed attribution) each have a named
pin. **Arms I checked and found sound** (recorded so the audit is visible, no
action needed): B1a-1's leap/common February contrast *and* its no-clamp `dom=15`
arm; B1a-2's strictly-after pair; B1a-4's on-the-boundary `through` contrast;
B3-2's *actual* base switch between two PUTs (the re-stamp is genuinely
contrasted, not asserted twice); B2-11's LIST-endpoint assertion **and** its
manual-row `null` contrast; B2-9's `max()` upper branch against B2-8's lower
branch (both directions are covered); B1b-3's unpaused sibling; B3-6's
income-does-not-offset, no-limit-absent and spent-0 arms.

Section A passes when **TC-Z1** (the full suite) is green; per-case status is the
backend's report, not mine.

## GAPS found in the plan's pytest lists (senior-lead rules; I do not rewrite plan.md)

- **GAP-1 — the 366-cap fixtures are arithmetically impossible; both cap tests are
  vacuous as written (B1a-5, B1b-8).** Both specify a **weekly** template over a
  **3-year** window and assert "exactly `MAX_OCCURRENCES` dates". Three years of
  weekly occurrences is **~157** dates, not 366 — the cap is never reached, so
  both tests assert `len(...) == 366` against a list that can never be that long
  (they will fail outright), and if the expectation is "fixed" to 157 they stop
  testing the cap at all. **Proposed fix:** weekly with the watermark **≥ 8 years**
  back (e.g. `2018-08-01` with `today=2026-08-18` → 420 due Mondays: run 1 = 366
  ending `2025-08-04`, run 2 = the remaining 54 ending `2026-08-17`, run 3 = 0).
  A monthly cap fixture would need 30.5 years and should not be used. Pinned live
  regardless by TC-B1b-7.
- **GAP-2 — the catch-up test never contrasts per-date rates, so a hoisted rate
  lookup passes (B1b-1).** B1b-1 materializes 3 missed dates and asserts the
  copied fields; B1b-5 asserts the due-date rate but has **one** due date. An
  implementation that resolves the rate **once per template** (outside the date
  loop — using `dates[0]`, or `today`) satisfies both. That is precisely the bug
  the due-date rule exists to prevent, and it is invisible in a base-currency
  fixture (where `auto_snapshot` is never called). **Proposed fix:** make B1b-1's
  template **foreign-currency** with three *different* seeded rates on the three
  due dates and assert three *different* `base_amount_minor` values. Pinned live
  by TC-B1b-2.
- **GAP-3 — the rate-miss arm of B1b-5 does not prove the miss is due-date-relative.**
  "No rate at or before the due date → `NULL/NULL`" is satisfied by an empty rate
  table, i.e. by code that looked up the *run* date and missed there too.
  **Proposed fix:** seed a rate on the **run date only** (nothing at or before the
  due date) → the honest answer is still `NULL/NULL`; a run-date implementation
  produces a number and fails. One extra seeded row.
- **GAP-4 — the atomicity test cannot observe the insert-vs-watermark ordering it
  claims to pin (B1b-9).** The injected `auto_snapshot` fault fires *while the
  inserts are still being staged*, i.e. **before** `tpl.last_materialized_on` is
  ever assigned and before any commit. So the property "the watermark can never
  say done without the rows that made it true being in the same commit" (D6, the
  whole justification for having no UNIQUE backstop) is never exercised: a
  hypothetical two-commit implementation (commit inserts, then commit the
  watermark) passes B1b-9 unchanged. What the test *does* prove — no per-date
  commit, no cross-template session — is worth keeping. **Proposed fix, two
  parts:** (a) a second fault position on the **last** due date, so 3 inserts are
  already staged when it fires (an autoflush/partial-commit implementation is then
  visible); (b) read template B's watermark back **in a fresh session** — with
  `expire_on_commit=False` the in-memory object is not a witness to what is in the
  database. Both are one line each. Also worth asserting explicitly that
  `materialize_due` returned normally (the plan says it, the assertion should too).
- **GAP-5 — nothing exercises two concurrent runs, which the design explicitly
  creates.** D5 schedules an **unconditional boot run-now** *plus* a 00:30 cron;
  the plan's own Disagreement 2 says these can coincide on a 00:30 restart and
  adds `SELECT … FOR UPDATE` for exactly that reason. No case in B1a-1..B3-9
  starts two runs. Without the lock both runs read the pre-run watermark and
  insert the same dates — the one duplicate the whole design claims is
  unrepresentable. **Proposed fix:** one test that does
  `asyncio.gather(materialize_due(sm, today=T), materialize_due(sm, today=T))`
  against a real Postgres sessionmaker and asserts exactly N rows and one
  watermark advance. If senior-lead judges this too timing-dependent for CI, the
  honest alternative is to record the lock as **review-verified only** — but
  "unpinned and undocumented" is not an option for the mechanism the no-backstop
  design leans on. I cannot cover it live (two interleaved curls prove nothing —
  the currencies-goals FOR-UPDATE verdict).
- **GAP-6 — the scheduler-gate test cannot tell the cron job from the boot run-now
  job, and never asserts the boot job at all (B1b-11).** Both jobs are the **same
  callable** (`materialize_due`), so "asserted by job func identity" is satisfied
  by an app that scheduled only *one* of them — including the failure mode where
  the cron is missing and only the boot run fires (materialization then works
  exactly once per process restart and silently stops, which no other test would
  catch). **Proposed fix:** assert on **triggers, not identity** — with recurring
  on, exactly **two** jobs whose func is `materialize_due`: one `CronTrigger`
  (UTC, configured hour/minute, `misfire_grace_time=3600`, `coalesce=True`) and
  one date/run-now job with `misfire_grace_time is None`; and assert **both**
  jobs' kwargs keys are `{"sessionmaker"}` (the plan pins only the cron's — a
  `today` frozen on the *boot* job is the same "single most dangerous line").
  Keep the four on/off combinations as written.
- **GAP-7 — no arm pins that a PATCH which is *not* a pause transition leaves the
  watermark alone (B2-8/B2-9 both pause first).** SL-A fires on `paused: true →
  false`. The web edit form will send the whole form back — including
  `paused: false` — on **every** save. A router implemented as
  `if payload.paused is False: last_materialized_on = max(...)` (no transition
  check) silently swallows every pending catch-up date on an ordinary amount edit,
  and passes B2-1..13 as written. **Proposed fix:** one arm — a **not-paused**
  template with a watermark two months back, PATCH `{"amount_minor": X,
  "paused": false}`, then `materialize_due` → the pending dates still materialize.
  Pinned live by TC-B2-5.
- **GAP-8 — the API is never asked to create a template with an explicit
  non-base currency (B2-1..3).** B2-1 covers `currency` omitted → base stamp; the
  foreign-currency templates in B1b are built by `db_session`, bypassing the
  router. A create handler that *always* stamps the base (ignoring a supplied
  `currency`) passes all 41 cases while quietly rewriting the user's money.
  **Proposed fix:** one arm in B2-1 — `currency: "USD"` → stored and returned
  `"USD"`. Pinned live by TC-B2-2.
- **GAP-9 — B2-7's February-clamp claim is not reachable from the API, and the
  OQ-1 `max()` floor is unpinned.** `_next_due_on` uses the router's real `today`,
  so "a `dom=31` February fixture" can only be written by re-deriving the expected
  date with the same `min(N, days_in(M))` rule the implementation uses — a
  re-implementation, which proves nothing (and in most run months the arm is
  simply unwritable). Separately, the recommendation the plan's own OQ-1 rests on
  — `after = max(last_materialized_on, today - 1 day)` — is not pinned by any of
  B2-7's four arms: all of them use a template created *today*, where the `max()`
  is a no-op. **Proposed fix:** leave the clamp to B1a-1 (which owns it properly)
  and replace that arm with the floor arm — a template whose watermark is two
  months back (pending catch-up) → `next_due_on >= today`, never the pending past
  date. I pin the clamp live instead, via a controlled-`today` materialization
  (TC-B2-4c).
- **GAP-10 — the `unconverted_count` arm cannot distinguish period-level from
  per-item counting (B3-7).** The design is explicit that the count is
  period-level (per-category counts would fork `tx_totals`' return shape). If the
  rateless row sits **inside** a limited category, a per-item implementation that
  happens to also emit a top-level total passes. **Proposed fix:** put the
  rateless row in a category with **no** limit (or uncategorized) → it must still
  be counted. Keep the rated-foreign contrast row as written. Pinned live by
  TC-B3-3.
- **GAP-11 — two designed behaviours of `GET`/`PUT /limits` are unasserted:**
  (a) `items` **ordered by `category_id`** ("for determinism", D16) — B3-6 creates
  several items and asserts none of the ordering; note the implementation sorts on
  `str(category_id)`, so the arm needs two limits whose id order differs from
  insertion order; (b) a limit on a **system (shared, `user_id IS NULL`) category**
  — the *normal* case for a fresh user, whose categories are all system rows.
  Every B3 arm uses an own category, so a `load_visible_category` misuse that
  rejects shared rows (or a fold keyed on the wrong id) would ship. **Proposed
  fix:** one assertion in B3-6 and one arm in B3-3. Pinned live by TC-B3-2/-3.
- **GAP-12 (minor) — nothing asserts the job never self-heals a missing profile.**
  D8 makes the job a *read context* (`read_base_currency`, never
  `_get_or_create_profile`); O-9 asks for grep evidence, which a later refactor
  can silently invalidate. **Proposed fix (optional):** one assertion in B1b-6
  that a profile-less user's row materializes at the `RUB` default **and** that
  `profiles` still has no row for them afterwards. I cover it live in TC-B1b-8
  either way.

**Not a gap, but flag for the engineer:** at B1b's /test the `/recurring` API does
not exist yet, so *all* of B1b's live setup is psql (PC-E). If the column list of
`recurring_templates` drifts from D2 during B1a, tell me — my inserts are written
against D2 verbatim.

---

# Section B — curl / direct-call test cases (owned by qa-engineer)

## TC-Z1 — full pytest suite green (runs FIRST at EVERY subtask's /test)
```bash
cd $API && TEST_DATABASE_URL=postgresql+asyncpg://budget:budget@localhost:5443/budget_test uv run pytest
```
Run **before** any server start (no competition for the test DB). Any failure →
capture, **do not fix backend code**, escalate to senior-lead.
- **Status**: ✅ pass — **run by senior-lead** as the authoritative gate (274 passed on `budget_test`; alembic upgrade/check/downgrade round-trip clean). Not re-run by QA (PM no-duplicate-gate policy).

---

# TC-B1a — DDL + models + pure math (structure only)

### TC-B1a-1: migration 0006 applies to the live DB and breaks nothing
- **Steps**: `uv run alembic upgrade head` on the live DB → restart 8010 →
  `GET /health`; `GET /transactions?limit=5`, `GET /categories`, `GET /stats/summary?period=month&month=<current>` with `$TOKEN_A`
- **Expected**: 200 everywhere; `TransactionRead` payloads still deserialize
  (the new nullable column is additive and **not yet** on the wire at B1a);
  server log free of tracebacks
- **Status**: ✅ pass — live DB was at `0005`; `alembic upgrade head` → `0006 (head)`, exit 0. Server (8011) `/health` 200 `{"status":"ok","database":"ok"}`; `GET /transactions?limit=5` 200 (14ms), `GET /categories` 200 (4ms), `GET /stats/summary?period=month&month=2026-08` 200 (21ms). A transaction was **created** so `TransactionRead` actually serialized (an empty list would be vacuous): key set is `{id, amount_minor, base_amount_minor, base_currency, category_id, created_at, currency, kind, merchant, note, occurred_at, receipt_id}` in **both** single-read and LIST — `recurring_template_id` **absent from the wire**, as B1a requires. Server log: zero tracebacks, statuses seen were 9×200 + 3×201, **no 5xx**.

### TC-B1a-2: the DDL is what the design says it is (psql structural pin)
- **Steps**: `\d recurring_templates`, `\d category_limits`, `\d transactions`
- **Expected**: `recurring_templates` — `last_materialized_on date NOT NULL`,
  `paused boolean NOT NULL DEFAULT false`, index on `user_id`, CHECKs
  `amount_minor_positive`, `kind_valid`, `currency_format`, `interval_unit_valid`,
  `day_of_month_range`, `weekday_range`, `anchor_matches_unit`; FK `user_id`
  ON DELETE CASCADE, FK `category_id` ON DELETE SET NULL. `category_limits` —
  composite PK `(user_id, category_id)`, both FKs CASCADE, the two CHECKs.
  `transactions.recurring_template_id uuid NULL` with FK **ON DELETE SET NULL**
  and **no index** (D13)
- **Status**: ✅ pass — every pin observed.
  `recurring_templates`: `last_materialized_on date NOT NULL`; `paused boolean NOT NULL DEFAULT false`; index `ix_recurring_templates_user_id btree (user_id)`; all 7 CHECKs present with the design's names (`amount_minor_positive`, `kind_valid`, `currency_format`, `interval_unit_valid`, `day_of_month_range`, `weekday_range`, `anchor_matches_unit` — the last reads `(interval_unit='month')=(day_of_month IS NOT NULL) AND (interval_unit='week')=(weekday IS NOT NULL)`); FK `user_id` → `users` **ON DELETE CASCADE**, FK `category_id` → `categories` **ON DELETE SET NULL`.
  `category_limits`: composite PK `pk_category_limits (user_id, category_id)`; both FKs **CASCADE**; CHECKs `amount_minor_positive`, `currency_format`.
  `transactions`: `recurring_template_id uuid` NULL, FK `fk_transactions_recurring_templates_recurring_template_id` **ON DELETE SET NULL**, and **no index** on it (`pg_indexes` filtered on the column returns zero rows) — D13 satisfied.

### TC-B1a-3: the CHECKs actually reject (with an accept contrast)
- **Steps**: three psql INSERTs in a transaction that is rolled back —
  (a) `interval_unit='month', day_of_month=NULL, weekday=3`; (b)
  `interval_unit='week', weekday=NULL, day_of_month=15`; (c) `amount_minor=0`;
  (d) the well-formed row of PC-E
- **Expected**: (a)(b) violate `anchor_matches_unit`, (c) violates
  `amount_minor_positive`, (d) **persists** — without (d) all three rejections
  would pass against a CHECK of `false`
- **Status**: ✅ pass — run inside one transaction with savepoints, fully rolled back.
  (a) `month` + `weekday=3`, `day_of_month=NULL` → `ERROR: violates check constraint "ck_recurring_templates_anchor_matches_unit"`
  (b) `week` + `day_of_month=15`, `weekday=NULL` → same `ck_recurring_templates_anchor_matches_unit`
  (c) `amount_minor=0` → `ERROR: violates check constraint "ck_recurring_templates_amount_minor_positive"`
  (d) **accept contrast** — the well-formed PC-E row → `INSERT 0 1`, `ACCEPT_ARM_ROWS=1`. Without (d) all three rejections would also pass against a CHECK of `false`; they don't. Post-`ROLLBACK` `count(*) = 0`.

### TC-B1a-4: contract zero-diff (O-1 negative arm)
- **Steps**: `curl -s $BASE/openapi.json` deep-compared with
  `apps/api/openapi.json`; `git status --porcelain` on both contract artifacts
- **Expected**: identical; **empty** git status — B1a ships no route and no DTO
- **Status**: ✅ pass — live `GET /openapi.json` (200) **deep-equals** the committed `apps/api/openapi.json` (`DEEP_EQUAL = True`, full-document Python comparison, not a key-subset check). No `/recurring` or `/limits` path in the contract and no `recurring_template_id` in `TransactionRead` — correct, B1a ships no route and no DTO. `git status --porcelain apps/api/openapi.json packages/api-client/src/generated/schema.d.ts` → **empty**; `grep -c recurring_template_id schema.d.ts` → **0**.

---

# TC-B1b — the materialization job (CFG-J direct call)

*pytest owns: the watermark algebra, the decision-table arms, the gate matrix. My
live layer owns: the job running through the app's own sessionmaker against the
real database and the real canonical rate table, per-date rate resolution, the cap
at real scale, and the wiring (CFG-S2, Q-1).*

### TC-B1b-1: pre-flight — census + a no-op run
- **Steps**: PC-C census (must be empty); `run_job 2026-08-18`
- **Expected**: `exit=0`; stderr free of tracebacks and of
  `recurring materialization failed`; `SELECT count(*) FROM transactions WHERE
  recurring_template_id IS NOT NULL` = 0
- **Status**: ⏸ pending

### TC-B1b-2: catch-up materializes each missed date once, each at ITS OWN due-date rate (GAP-2 live)
- **Setup**: PC-E template (user A, BYN 10000, expense, `dom=1`, category `$A_EXP`,
  merchant `qa-merch`, note `qa-note`, watermark `2026-05-31`)
- **Steps**: `run_job 2026-08-18`; then psql
  `SELECT occurred_at, amount_minor, currency, base_amount_minor, base_currency, kind, category_id, merchant, note, receipt_id, recurring_template_id FROM transactions WHERE user_id='$A_ID' ORDER BY occurred_at`
- **Expected**: exactly **3** rows, `occurred_at` ∈ {2026-06-01, 2026-07-01,
  2026-08-01}; each `base_amount_minor` = `10000 × rate(BYN→RUB, that date)`
  re-read by psql and hand-computed — at grooming **258572 / 267494 / 273045**,
  three **different** values; `base_currency='RUB'`; `amount_minor=10000`,
  `currency='BYN'`, kind/category/merchant/note copied verbatim; `receipt_id`
  NULL; `recurring_template_id` = the template id; template
  `last_materialized_on = 2026-08-01`
- **Status**: ⏸ pending

### TC-B1b-3: idempotency — the second run is a no-op (order-dependent: needs TC-B1b-2)
- **Steps**: `run_job 2026-08-18` again → recount
- **Expected**: still exactly 3 rows (same ids), watermark still `2026-08-01`,
  `exit=0`
- **Status**: ⏸ pending

### TC-B1b-4: honest snapshots — rateless and base-currency both `NULL/NULL`
- **Setup**: template T2 = **GBP** 5000, `dom=2`, watermark `2026-06-30`;
  template T3 = **RUB** 30000, `dom=3`, watermark `2026-06-30`
- **Steps**: `run_job 2026-07-05`
- **Expected**: T2's row (`2026-07-02`) → `base_amount_minor IS NULL AND
  base_currency IS NULL` (rate miss, never a guess, never the run-date rate);
  T3's row (`2026-07-03`) → also `NULL/NULL` (a base-currency row carries no
  snapshot — never a self-copy); both watermarks advanced
- **Status**: ⏸ pending

### TC-B1b-5: paused is skipped and frozen; `end_date` is a hard boundary
- **Setup**: T4 paused, `dom=5`, watermark `2026-05-31`; T5 not paused, `dom=5`,
  watermark `2026-05-31`; T6 `dom=7`, `end_date=2026-07-07`, watermark `2026-05-31`
- **Steps**: `run_job 2026-08-18`
- **Expected**: T4 → **zero** rows, watermark unchanged `2026-05-31`; T5 → 3 rows
  (Jun/Jul/Aug 5) — the sibling is what proves the run happened at all; T6 → rows
  on `2026-06-07` and `2026-07-07` only, watermark `= 2026-07-07`; a further
  `run_job 2026-09-01` adds nothing for T6 (ended) and nothing for T4 (paused)
- **Status**: ⏸ pending

### TC-B1b-6: day-31 clamp at real scale, leap vs common (money-free, RUB templates)
- **Setup**: T7 = RUB, `dom=31`, watermark `2026-01-30`; T8 = RUB, `dom=31`,
  watermark `2028-01-30`
- **Steps**: `run_job 2026-04-30`; then `run_job 2028-03-01`
- **Expected**: T7 → `occurred_at` exactly `[2026-01-31, 2026-02-28, 2026-03-31,
  2026-04-30]` (**Feb 2026 is a common year → 28**, no skip, no roll-over into
  March); T8 → exactly `[2028-01-31, 2028-02-29]` (**leap → 29**) — the two
  templates are each other's contrast. Future-dated rows are on a throwaway user
  and die at cleanup (Q-3)
- **Status**: ⏸ pending

### TC-B1b-7: the 366 cap truncates, warns, and the REMAINDER arrives on the next run (GAP-1 live)
- **Setup**: T9 = RUB weekly, `weekday=0` (Monday), watermark **2018-08-01**
- **Steps**: `run_job 2026-08-18` (run 1) → count + watermark + **stderr**;
  `run_job 2026-08-18` (run 2) → count + watermark; `run_job 2026-08-18` (run 3)
- **Expected**: run 1 → exactly **366** rows, first `2018-08-06`, last
  `2025-08-04`, watermark `2025-08-04`, stderr carries the
  `capped at 366` warning; run 2 → **+54** rows (420 total), last `2026-08-17`,
  watermark `2026-08-17`, **no** cap warning; run 3 → **0** new rows. Every
  `occurred_at` is a Monday and every date is unique (`SELECT count(*) <>
  count(DISTINCT occurred_at)` must be false)
- **Status**: ⏸ pending

### TC-B1b-8: per-owner base currency, and the job never self-heals a profile (GAP-12 live)
- **Setup**: `UPDATE profiles SET base_currency='USD' WHERE user_id='$B_ID'`
  (CFG-P, Q-2); identical BYN templates on A (base RUB) and B (base USD),
  `dom=1`, watermark `2026-06-30`. Then `DELETE FROM profiles WHERE
  user_id='$C_ID'` for a third throwaway user C carrying a BYN template
- **Steps**: `run_job 2026-07-05`
- **Expected**: A's row → `base_currency='RUB'` at the BYN→RUB `2026-07-01` rate;
  B's row → `base_currency='USD'` at the BYN→USD `2026-07-01` rate (both
  hand-computed from psql-read rates; the two numbers differ); each row under its
  own `user_id`; C's row → `base_currency='RUB'` (the default) **and**
  `SELECT count(*) FROM profiles WHERE user_id='$C_ID'` is still **0**
- **Status**: ⏸ pending

### TC-B1b-9: archived category still materializes as stored (D11)
- **Setup**: template on `$A_ARCH` (archived after creation), watermark yesterday-ish
- **Steps**: `run_job <a due date>`
- **Expected**: the row carries the **stored** `category_id` (not NULL); the
  template is **not** paused as a side effect; `exit=0`, no warning line
- **Status**: ⏸ pending

### TC-B1b-10: **CONDITIONAL (Q-1)** — the scheduler really fires (O-11, CFG-S2)
- **Steps**: one due template on a throwaway user; start a **second** server on
  **8011** with `RECURRING_SCHEDULER_ENABLED=true`, `FX_SCHEDULER_ENABLED=false`,
  `RECURRING_MATERIALIZE_HOUR_UTC`/`_MINUTE_UTC` ≈ 2 minutes ahead of real UTC;
  observe the boot run-now, wait past the cron minute, then kill the server
- **Expected**: the boot run materializes exactly the due dates **once**; the
  cron fires (log line) and adds **nothing** (idempotency under the real
  scheduler, with a real `today` computed inside the job, not a frozen kwarg);
  no traceback at boot or shutdown; 8010 stays gated off throughout
- **If not authorized**: 🚫 **blocked-non-gating** — recorded, does not fail the
  scope (the pytest gate matrix with GAP-6 fixed is then the only guard)
- **Status**: ✅ covered by stop-probe 2026-08-18 (see "B1b STOP-PROBE" below —
  PROBE-2 is the boot run-now, PROBE-3 the cron fire + no-op)

---

# TC-B2 — `/recurring` CRUD + attribution

### TC-B2-1: 401 wall (once per router) + contract live == committed
- **Steps**: no-token `POST /recurring`, `GET /recurring`, `PATCH /recurring/<uuid>`,
  `DELETE /recurring/<uuid>`; then `curl -s $BASE/openapi.json` vs
  `apps/api/openapi.json`; `grep recurring_template_id packages/api-client/src/generated/schema.d.ts`
- **Expected**: **401** ×4 (never 404/422 — the wall wins over routing);
  live contract deep-equals the committed one; the diff vs HEAD is
  **additive-only** (new `/recurring` paths + `TransactionRead.recurring_template_id?:
  string | null`, zero deletions); no `prime_rate_limit` on the mount (no
  `X-RateLimit`/429 surface on `/recurring`)
- **Status**: ⏸ pending

### TC-B2-2: CRUD happy path + the currency stamp, both ways (GAP-8 live)
- **curl**:
```bash
curl -s -X POST $BASE/recurring -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' \
  -d '{"name":"rent","amount_minor":5000000,"kind":"expense","category_id":"'$A_EXP'","interval_unit":"month","day_of_month":5}'
```
- **Expected**: **201**; body keys exactly `{id, name, amount_minor, kind,
  currency, category_id, merchant, note, interval_unit, day_of_month, weekday,
  end_date, paused, next_due_on, created_at}` — **`last_materialized_on` ABSENT**
  (lean-DTO rule; verified off-wire by psql, and it equals `today_utc − 1`);
  `currency == "RUB"` (base stamp), `paused == false`, `weekday == null`.
  Second create with `"currency":"USD"` → **201 with `currency == "USD"`** (the
  explicit value is NOT overwritten by the base stamp). `GET /recurring` →
  `{items:[…]}` ordered by `created_at, id`, user B's templates **absent**, a
  paused one and a past-`end_date` one both present. `PATCH {"amount_minor":
  6000000}` → 200 with every other field intact. `DELETE` → **204**; second
  DELETE → **404 `{"detail":"RECURRING_TEMPLATE_NOT_FOUND"}`**; user B's template
  id → the **byte-identical** 404 (no oracle)
- **Status**: ⏸ pending

### TC-B2-3: the 422 pack on the wire, with accept arms
- **Steps**: create — `month` without `day_of_month`; `month` **with** `weekday`;
  `week` without `weekday`; `weekday: 7`; `day_of_month: 0`; `day_of_month: 32`;
  `amount_minor: 0`; `amount_minor: 1000000000000000` (MAX+1); blank/whitespace
  `name`; `interval_unit: "day"`; foreign/unknown `category_id`; archived
  `category_id`. Accept arms: `amount_minor: 999999999999999` (MAX) → 201;
  `week` + `weekday: 6` → 201. PATCH — explicit nulls on `name`/`amount_minor`/
  `kind`/`currency`/`interval_unit`/`paused`; `month → week` without `weekday`;
  `weekday` sent on an unchanged monthly template; explicit null `end_date`
- **Expected**: create-side shape errors → **422 `HTTPValidationError`**;
  category refs → **422 `CATEGORY_NOT_FOUND` / `CATEGORY_ARCHIVED`**; PATCH nulls
  → the matching **`*_REQUIRED`** code; unit switch without anchor →
  **`ANCHOR_REQUIRED`**; stray anchor → **`ANCHOR_MISMATCH`**; explicit null
  `end_date` → **200 and cleared**; both accept arms 201 (without them every
  rejection would pass against a route that 422s everything)
- **Status**: ⏸ pending

### TC-B2-4: `next_due_on` hand-pinned, including a real clamp and the OQ-1 floor (GAP-9 live)
- **Steps / Expected** (each a fresh template on user A; `D` = today's UTC day):
  - (a) `dom = D` on a template created today → `next_due_on == today`
  - (b) `dom = D−1` (or `D+1`, whichever avoids month edges — recorded in the run)
    → the hand-written date next month / this month, spelled out literally
  - (c) **clamp**: `dom = 31`; `run_job <the first due date>` to advance the
    watermark past the current month, then `GET /recurring` → `next_due_on` is
    the **hand-written clamped date** of the following short month (e.g.
    `2026-09-30`, not `2026-09-31`, not `2026-10-01`) — the server does the
    clamping, the client never recomputes
  - (d) `paused: true` → `next_due_on == null`
  - (e) `end_date` in the past → `next_due_on == null` (and the template is still
    LISTED)
  - (f) **floor**: psql-rewind a live template's watermark two months back →
    `next_due_on >= today` (never the pending past date), and the pending dates
    still materialize on the next `run_job`
- **Status**: ⏸ pending

### TC-B2-5: materialize → attribute → idempotent → edit-affects-future-only (order-dependent; GAP-7 live)
- **Steps**: POST a BYN monthly template (`dom = D`) → `run_job <due date>` →
  `GET /transactions` (LIST) and `GET /transactions/{id}` (single) → `run_job`
  again → `PATCH {"amount_minor": NEW, "paused": false}` → `run_job <next due
  date>`
- **Expected**: exactly one row after the first run, `occurred_at` = the due date,
  `base_amount_minor` = the psql-read due-date BYN→RUB conversion,
  `recurring_template_id` present **in the LIST payload and in the single read**;
  second run → still one row; after the PATCH the *pending* dates still
  materialize (GAP-7: a `paused: false` in an ordinary edit must not move the
  watermark) and the new row carries the **NEW** amount while the first row is
  **byte-unchanged** (D12: edits never retro-write history)
- **Status**: ⏸ pending

### TC-B2-6: pause → unpause → delete lifecycle (SL-A and SL-C live; order-dependent on TC-B2-5)
- **Steps**: weekly template (`weekday` = today's weekday) with a watermark
  rewound ≥ 2 occurrences; `PATCH {"paused": true}` → `run_job today` →
  `PATCH {"paused": false}` → `run_job today` → `run_job today` again →
  `PATCH {"paused":true}` + `PATCH {"paused":false}` on the same day →
  `run_job today` → `DELETE /recurring/{id}`
- **Expected**: paused run → **zero** rows; unpause → exactly **one** row dated
  **today**, the skipped occurrences **never** appear (pause means "don't create
  these", not "create them later"); the repeat run adds nothing; the same-day
  pause/unpause cycle adds **nothing** (the SL-A `max()`; a bare `= today − 1`
  would duplicate today's row); DELETE → **204**, the transactions survive with
  every money field intact and `recurring_template_id` **NULL**
- **Status**: ⏸ pending

### TC-B2-7: attribution is server-managed (SL-B live) and null on manual rows
- **Steps**: `POST /transactions` with `recurring_template_id` in the body;
  `PATCH` a materialized row with a *different* template id in the body; plain
  manual `POST /transactions`
- **Expected**: POST → **201** with `recurring_template_id: null` in the response
  **and** NULL in the database (extra fields are ignored, not 422 — the house
  policy); PATCH → the stored id **unchanged**; the manual row reads `null` in
  POST, single GET **and** LIST (the contrast that gives the field meaning)
- **Status**: ⏸ pending

---

# TC-B3 — `/limits`

### TC-B3-1: 401 wall (once per router) + contract live == committed
- **Steps**: no-token `GET /limits`, `PUT /limits/<uuid>`, `DELETE /limits/<uuid>`;
  contract deep-compare + `git status` on both artifacts
- **Expected**: **401** ×3; `LimitsRead` renders `month`, `currency`,
  `items[].{category_id,limit_minor,limit_currency,spent_minor}` and
  `unconverted_count` as **required**; additive-only diff; no rate-limit surface
- **Status**: ⏸ pending

### TC-B3-2: PUT / GET / DELETE cycle + the category rules (GAP-11 live)
- **curl**:
```bash
curl -s -X PUT $BASE/limits/$A_EXP -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' -d '{"amount_minor":3000000}'
curl -s -X PUT $BASE/limits/$A_EXP -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' -d '{"amount_minor":4000000}'
curl -s "$BASE/limits" -H "Authorization: Bearer $TOKEN_A"
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE $BASE/limits/$A_EXP -H "Authorization: Bearer $TOKEN_A"
```
- **Expected**: first PUT → **200 `{category_id, limit_minor: 3000000,
  limit_currency: "RUB"}`**; second PUT → 200 and `GET` shows **exactly one**
  item at `4000000` (upsert, not a second row); `$SYS_EXP` (system/shared
  category) → **200** and listed; DELETE → **204** then absent from GET; DELETE
  again → **404 `LIMIT_NOT_FOUND`**; user B's limit → the byte-identical 404;
  unknown/foreign category on PUT → **404 `CATEGORY_NOT_FOUND`** (path resource,
  not 422); archived → **422 `CATEGORY_ARCHIVED`**; income category `$A_INC` →
  **422 `CATEGORY_NOT_EXPENSE`**; `amount_minor` 0 and MAX+1 → 422, MAX → 200
- **Status**: ⏸ pending

### TC-B3-3: hand-pinned `spent` over two currencies, and the API returns RAW NUMBERS ONLY (GAP-10 live)
- **Setup** (user A, current UTC month, all via `POST /transactions`):

  | # | category | kind | currency | amount_minor | role |
  |---|---|---|---|---|---|
  | s1 | `$A_EXP` | expense | RUB | 150000 | native, base bucket |
  | s2 | `$A_EXP` | expense | BYN | 10000 | **converted** at its `occurred_at` rate |
  | s3 | `$A_EXP` | income | RUB | 900000 | must **not** offset |
  | s4 | `$A_EXP2` | expense | RUB | 20000 | second limited category |
  | s5 | `$A_EXP3` | expense | RUB | 777000 | spending with **no limit** → absent |
  | s6 | `$A_EXP3` | expense | GBP | 5000 | **rateless, unlimited category** → excluded + counted |
  | — | `$SYS_EXP` | — | — | — | limit set, **no rows** → `spent_minor == 0`, still listed |
  | — | `$A_ARCH` | — | — | — | limit set **before** archiving → still listed |

- **Expected**: `currency == "RUB"`; `items[$A_EXP].spent_minor == 150000 +
  round(10000 × rate(BYN→RUB, s2.occurred_at))` — psql-read and hand-computed,
  the income row **not** subtracted; `items[$A_EXP2].spent_minor == 20000`;
  `$A_EXP3` **absent**; `$SYS_EXP` present with `0`; `$A_ARCH` present;
  **`unconverted_count == 1`** driven by a row in an *unlimited* category
  (period-level, not per-item); `items` ordered by `category_id` ascending.
  **Over-limit is client-side**: with `$A_EXP2`'s limit set **below** its spent,
  the item's key set is still exactly `{category_id, limit_minor, limit_currency,
  spent_minor}` — **no** `status`, `exceeded`, `percent`, `remaining`, and no
  extra top-level key beyond `{month, currency, items, unconverted_count}`
- **Status**: ⏸ pending

### TC-B3-4: month window and default (order-dependent on TC-B3-3)
- **Steps**: `GET /limits?month=<previous month>`; `GET /limits` (no param);
  `GET /limits?month=2026-13`; `GET /limits?month=1969-01`
- **Expected**: previous month → the same items with `spent_minor == 0` (limits
  are period-independent, spending is not) and `month` echoed; no param → the
  **current UTC month** echoed and TC-B3-3's numbers; `2026-13` → **422**;
  out-of-envelope year → 422 (`MONTH_PATTERN`), never a 500
- **Status**: ⏸ pending

### TC-B3-5: base switch — surfaced, never converted, re-stamped on rewrite (D15 live; CFG-P/Q-2)
- **Steps**: with the limit set under RUB, `UPDATE profiles SET
  base_currency='USD' WHERE user_id='$A_ID'` → `GET /limits` → `PUT` the same
  amount again → `GET /limits`
- **Expected**: after the switch → `currency: "USD"`, `limit_currency: "RUB"`,
  `limit_minor` **unchanged** (no conversion, no reinterpretation — the client
  renders the mismatch state); `spent_minor` recomputed **in USD** (hand-pinned
  from the RUB→USD rates on the rows' dates; the stale-snapshot rows fall to
  bucket 3 by design); after the re-PUT → `limit_currency: "USD"` and
  `updated_at` advanced (psql). Restore the base to RUB before the remaining TCs
- **Status**: ⏸ pending

### TC-B3-6: user scoping — two independent leak paths
- **Steps**: user B sets a limit on a shared system category and posts expenses
  there; `GET /limits` as A and as B
- **Expected**: A never sees B's limit **and** never sees B's spending in the
  same (shared) category — the limit read and the aggregate are two separate
  scoping mistakes; each user's `spent_minor` is their own
- **Status**: ⏸ pending

### TC-B3-7: the 5.3 × 5.4 seam — materialized rows count toward the limit (live-only by design)
- **Steps**: a limit on `$A_EXP`; a recurring template on `$A_EXP` (RUB, `dom` in
  the current month); `run_job <due date>`; `GET /limits`
- **Expected**: `spent_minor` grows by exactly the template's `amount_minor` —
  a materialized transaction is an ordinary transaction to the aggregate. No
  pytest case in either subtask crosses this seam (B3's fixtures have no
  templates, B2's have no limits), so this is the only place the two features are
  observed together
- **Status**: ⏸ pending

---

## STOP rules — what aborts the session

| Trigger | Ruling |
|---|---|
| **Any 5xx** on any endpoint, or any traceback in the server log | **STOP** |
| `materialize_due` **raises** (non-zero exit from the runner) | **STOP** — D5's "never raises" is the whole reason boot cannot fail from it |
| A `recurring materialization failed for …` warning for a template I did not deliberately poison | **STOP** — one poisoned template must not be *created* by ordinary data |
| A **duplicate** materialized row (same template, same `occurred_at`) after any repeat run | **STOP** — the no-UNIQUE-backstop design is broken |
| The watermark advanced **past** a date that has no transaction row (or rows exist past the watermark) | **STOP** — the atomicity claim is broken |
| A snapshot computed at the **run** date instead of the **due** date, or a guessed rate where the honest answer is `NULL/NULL` | **STOP** — money written from a wrong rate |
| `exchange_rates` row count or pair set differs from the PC-C snapshot | **STOP** — this scope must not touch the rate table |
| Templates present at PC-C that belong to users outside this run | **STOP-and-ask** (Q-3) — the job is global |
| Any write by me to `conftest.py`, `docker-compose.yml`, `.env*`, or any repo file | **STOP** — env-only setup; the runner lives in the scratchpad |
| `alembic` migration pending at B1b/B2/B3, or a migration authored outside B1a | **STOP-and-escalate** |
| Live `/openapi.json` ≠ committed `apps/api/openapi.json`, or a non-zero diff at B1a/B1b | **STOP** — contract drift (never hand-edit the artifact) |
| A 401 wall that answers 404/422 first on either new router | **STOP** — the anonymous caller learns resource existence |
| `last_materialized_on` visible on the wire | **STOP** — internal bookkeeping (D10) |
| A server `status`/`exceeded`/`percent` field on `/limits` | **STOP** — D18 says the comparison is the client's |

**Latency** is recorded (`%{time_total}`) but is not a STOP; `GET /limits` over
100 ms at fixture scale is reported to senior-lead (the D13 re-arm trigger).

## What I explicitly do NOT test (and why)

- **Anything the pure suite proves** — clamp/weekday/window algebra is B1a's; I
  re-pin it live only where the *live* path can lie (TC-B1b-6, TC-B2-4c).
- **Concurrency / the `FOR UPDATE` lock** — two interleaved curls or two shell
  jobs prove nothing reliably (currencies-goals verdict). It belongs in pytest
  (GAP-5) or in review.
- **The real cron at 00:30 UTC** — unobservable in a test window; CFG-S2's
  minute-ahead cron is the honest substitute (Q-1).
- **Web screens** (templates list, badge, "spent X of Y" bars, the ru polish
  items) — web-qa owns them; my contract and code pins underwrite them. The
  **`weekday` 0=Monday vs JS `getDay()` 0=Sunday** trap is flagged to web-qa here
  because the server side alone cannot catch it.
- **Mobile** — frozen.
- **`EXPLAIN ANALYZE` / index plans** — the plan's O-5 verdict, not QA's.

## Open questions for senior-lead (before /test starts)

1. **O-11 vs "no live scheduler at /test".** The plan obliges QA to prove the cron
   and the unconditional boot run-now actually fire; the env rule forbids a live
   scheduler. **Recommendation: authorize CFG-S2** — a throwaway server on **8011**
   with `RECURRING_SCHEDULER_ENABLED=true`, FX off, the materialize hour/minute set
   ~2 minutes ahead, one due template on a throwaway user, killed immediately after.
   8010 stays gated off. If refused, TC-B1b-10 is 🚫 blocked-non-gating and GAP-6's
   pytest fix becomes mandatory rather than recommended.
2. **psql writes to `profiles` on throwaway users (CFG-P).** No endpoint changes
   `base_currency`, so the D15 mismatch/re-stamp pin (TC-B3-5), the per-owner-base
   pin (TC-B1b-8) and the profile-less arm (GAP-12) all need
   `UPDATE`/`DELETE FROM profiles` on rows *this run created*. **Recommendation:
   approve** (the stats-advisor precedent psql-seeded rates; here rates stay
   untouched and only run-scoped users are written).
3. **The job is global, and I need a future `today`.** `materialize_due` has no
   user filter: at /test it processes **every** template in the live DB, and the
   leap-February clamp pin (TC-B1b-6) calls it with `today=2028-03-01`, which
   would write **future-dated** money rows for any template that is not mine.
   **Recommendation:** STOP-and-report if PC-C's census is non-empty (rather than
   deleting other people's templates myself), and confirm that future-dated
   transactions on run-scoped throwaway users, deleted at cleanup, are acceptable.
4. **GAP disposition.** Which of **GAP-1..12** land as pytest arms in the plan?
   My recommendation: **GAP-1, -2, -3, -4, -6, -7, -8, -9, -10, -11 as pytest**
   (each is one fixture number, one arm or one assertion — GAP-1 is a
   *correctness* fix, the two cap tests cannot pass as written); **GAP-5** either
   as the `asyncio.gather` test or explicitly recorded as review-only;
   **GAP-12** optional (I cover it live).

## Final report (filled at each subtask's /test)

```
### Section A (pytest)
- Total: N · ✅ Pass: N · ❌ Fail: N — (list)

### Section B (curl / direct call)
- Total: N · ✅ Pass: N · ❌ Fail: N — (list) · 🚫 Blocked: N — (list + reason)

**Overall**: ✅ READY FOR REVIEW / ❌ FAIL — escalate to senior-lead
```

Per subtask also: the STOP-trigger line ("no STOP triggered" or which fired), the
`exchange_rates` before/after line (count + pair set unchanged), the census line
(templates before/after), the cleanup line (run-scoped users deleted, cascade
counts, orphan checks 0/0, ports free, git tree unchanged), and — if CFG-S2 ran —
its start/kill timestamps. Any ❌ → **FAIL OVERALL**; a 🚫 on **TC-B1b-10 only**
does not fail the scope.


---

# B1a /test run — 2026-08-18 (qa-engineer)

**Executed the B1a block only.** B1b/B2/B3 remain ⏸ (no job, no `/recurring`, no
`/limits` exist yet). Port: **8011** — 8010 was held by a parallel simulator QA
session and was left untouched (verified still 200 after my server was killed).

### Section A (pytest)
- Total: 1 gate (TC-Z1) · ✅ Pass: 1 · ❌ Fail: 0 — 274 passed, run by senior-lead;
  not re-run here.

### Section B (curl / direct call)
- Total: 4 (TC-B1a-1..4) · ✅ Pass: 4 · ❌ Fail: 0 · 🚫 Blocked: 0

**Overall**: ✅ READY FOR REVIEW

- **STOP triggers**: none fired. No 5xx (only 200/201), no traceback in the server
  log, no contract drift, no write to `exchange_rates`, no repo file written by QA.
- **Migration**: live DB `0005 → 0006 (head)`. The default `apps/api/.env` was
  confirmed to point at the live DB (`postgresql+asyncpg://budget:budget@localhost:5443/budget`)
  **before** upgrading. The live DB was **never** downgraded.
- **exchange_rates before/after**: 2282 rows / 6 pairs
  (`BYN|EUR 398, BYN|RUB 401, BYN|USD 401, EUR|USD 280, RUB|EUR 401, RUB|USD 401`)
  — byte-identical. CFG-R held: B1a touched no rates.
- **Census before/after**: `recurring_templates` empty before (table did not exist
  pre-migration) and **0** after — no foreign templates, Q-3 not engaged.
- **Cleanup**: `DELETE FROM users WHERE email LIKE 'qa_rl_%'` → `DELETE 1` (cascade);
  orphan checks `recurring_templates=0`, `category_limits=0`,
  `transactions WHERE recurring_template_id IS NOT NULL = 0`; `transactions` back to
  its pre-run 870. Port 8011 free (only my server killed, 8010 survives);
  `git status --porcelain` **identical** to the pre-QA snapshot; the scratchpad SQL
  never entered the repo.

---

## B1b STOP-PROBE (2026-08-18) [stop-probe]

**Not the full checklist.** Per the QA-cadence policy, B1b is an integration
boundary (first scheduler job of the scope), so it gets a 4-check live probe only;
**TC-B1b-1..9 stay ⏸ pending** for the scope-end full run. TC-B1b-10's substance
(O-11 live-scheduler proof under CFG-S2, authorized by Q-1) **is** covered here by
PROBE-2 + PROBE-3.

**Shared setup** (one throwaway user, port **8011** only — 8010 was held by a
parallel simulator QA session and was never started, stopped or probed):
`qa_rl_b1b_1787076317@example.com` registered + one expense category via the API on
my own 8011 server; one template seeded by psql per PC-E (D2 column list verbatim):
RUB 12345, expense, `month`/`dom=1`, merchant `qa-merch`, note `qa-note`,
`last_materialized_on=2026-06-15`, not paused, no `end_date`. Real UTC at probe
time: 2026-08-18 18:0x → hand-computed due window `(2026-06-15, 2026-08-18]` with
`dom=1` = **{2026-07-01, 2026-08-01}**. PC-C census before: `recurring_templates`
**empty** (Q-3 not engaged); `exchange_rates` 2282 rows / 6 pairs; `transactions` 871.

### PROBE-1 — flag-off inertness — ✅ PASS
- **Setup**: server on 8011 with `FX_SCHEDULER_ENABLED=false
  RECURRING_SCHEDULER_ENABLED=false`; due template in place; waited 16 s.
- **Expected**: health 200; zero rows with `recurring_template_id IS NOT NULL`;
  watermark unchanged; no scheduler/materialize line in the log.
- **Observed**: `health=200 {"status":"ok","database":"ok"}`; materialized rows
  **0**; user rows **0**; watermark still `2026-06-15`; log grep for
  `scheduler|recurring|materiali|apscheduler` → **no match**. Clean shutdown.

### PROBE-2 — unconditional boot catch-up under the real scheduler — ✅ PASS
- **Setup**: restart on 8011 with `RECURRING_SCHEDULER_ENABLED=true`,
  `FX_SCHEDULER_ENABLED=false`, `RECURRING_MATERIALIZE_HOUR_UTC=18`,
  `_MINUTE_UTC=9` (≈3 min ahead of real UTC 18:06:45). Root-level log config from
  the scratchpad (uvicorn's default leaves APScheduler's INFO lines unhandled) —
  no repo file touched.
- **Expected**: exactly `[2026-07-01, 2026-08-01]`, fields copied verbatim,
  `receipt_id` NULL, `recurring_template_id` set, watermark `2026-08-01`; RUB
  template on a RUB-base profile → `base_amount_minor`/`base_currency` both NULL
  (no self-copy); no traceback, no `recurring materialization failed`.
- **Observed** (psql, `occurred_at|amount|ccy|base_amt|base_ccy|kind|category|merchant|note|receipt|tpl`):
```
2026-07-01|12345|RUB|NULL|NULL|expense|2650bff1-…|qa-merch|qa-note|NULL|3049cd21-…
2026-08-01|12345|RUB|NULL|NULL|expense|2650bff1-…|qa-merch|qa-note|NULL|3049cd21-…
```
  count **2**, watermark **2026-08-01**, global materialized **2**, `transactions`
  871→**873**. Boot job in the log:
  `Running job "materialize_due (trigger: date[…], next run at: 2026-08-18 18:06:45 UTC)"`
  → `executed successfully`, 0.11 s. Zero tracebacks, zero WARNING lines.

### PROBE-3 — the cron really fires and is a no-op — ✅ PASS
- **Setup**: server kept up past 18:09:00 UTC, then killed.
- **Expected**: cron job-execution evidence AND unchanged row count/watermark
  (idempotency under the real scheduler, `today` computed in-job); no shutdown
  traceback.
- **Observed**:
```
21:09:00,042 INFO apscheduler.executors.default Running job "materialize_due (trigger: cron[hour='18', minute='9'], next run at: 2026-08-19 18:09:00 UTC)" (scheduled at 2026-08-18 18:09:00+00:00)
21:09:00,237 INFO apscheduler.executors.default Job "materialize_due (…cron…)" executed successfully
```
  post-cron rows **2** (same two ids), watermark still **2026-08-01**,
  `transactions` still **873**. Shutdown: `Scheduler has been shut down` →
  `Application shutdown complete` — `grep -c Traceback` = **0**.

### PROBE-4 — cleanup (CFG-C) — ✅ PASS
`DELETE FROM users WHERE email LIKE 'qa_rl_%'` → `DELETE 1` (cascade).
`recurring_templates=0`, `category_limits=0`, `transactions WHERE
recurring_template_id IS NOT NULL = 0`, `transactions` back to **871**.
`exchange_rates` **2282** rows and the 6-pair breakdown **byte-equal** to the
pre-probe snapshot (`diff` empty) — CFG-R held, no write to the rate table.
Port 8011 free; 8010 still owned by the same foreign pid it had before I started.
`git status --porcelain` byte-identical to the pre-session capture (verified before
this section was appended; the only post-probe delta is this checklist file).

**STOP triggers**: none fired. No foreign census row, no rate delta, no traceback,
no row materialized that I did not seed, nothing touched on 8010.
