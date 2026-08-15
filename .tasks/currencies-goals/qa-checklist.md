# QA Checklist: currencies-goals (scope 3.1–3.4 backend; 3.5 web deferred to web-qa)

**SCOPE QA STRATEGY, mapped by subtask.** Grooming artifact — nothing is executed
now. Each block runs at the **/test stage of its own subtask** (S1's checks at S1's
/test, etc.). All backend subtasks S1–S5 are **FULL tier** (plan.md), so the full
detailed format with exact commands applies to every section below. The web
subtasks (plan-web.md, STANDARD tier — file not yet written at grooming time) get
the **lightweight checklist treatment** (name / one-line scenario / expected /
owner, no pre-written curl blocks — PM policy 2026-07-27 in the qa-checklist
skill) and are **owned by web-qa**, not this file. My API-level checks underwrite
every code/shape the web consumes.

The split rule (per plan.md "Test guidance for QA", adopted with the pushbacks in
§Pushbacks): pytest owns business logic, the PATCH/create decision tables, the
D11 domain math, DB consistency, and the FX seam **mocked at
`app.state.fx_fetcher`**. My live layer owns what the mocked-seam suite cannot
prove: the ONE real-fetch session (boot catch-up against real providers), the
[SL-4] provider probes, alembic 0005 lifecycle + DDL-level CHECKs on real PG,
Pydantic pattern 422s, 401 walls on the two new routers, live-vs-committed
openapi shapes, cross-request journeys (snapshot lifecycle, summary
before/after a rate, the goals end-to-end journey with hand-pinned math), and
the no-oracle wire bytes. At each /test I also run the full pytest suite green
(TC-Z1) and do NOT write or fix backend code — failures are captured and
escalated to senior-lead.

---

## Live-FX test strategy — MY RULING (senior-lead reviews; receipts R2 style)

**Adopt the plan's live-layer strategy with two stated refinements (P1/P2 in
§Pushbacks):**

1. **Default = mock at the `app.state.fx_fetcher` seam in ALL pytest** (no pytest
   ever makes live HTTP — receipt_parser precedent), PLUS exactly **ONE real-fetch
   session** at **S1's /test**: empty `exchange_rates` on the live DB → boot
   catch-up populates all 6 canonical pairs with ~400-day history → psql
   verification + plausibility bands + the [SL-4] frankfurter-RUB probe and NBRB
   `Cur_Scale` plausibility check, all in that one session (TC-S1-3/4/5).
2. **P1 — the session's `/fx/convert` half runs at S2's /test**, not S1's:
   `GET /fx/convert` does not exist until S2. TC-S2-3 curls it against the REAL
   rows persisted at S1 (live `budget` DB, untouched by pytest) with the
   scheduler **disabled** — zero additional external HTTP. The plan's proposed
   single-session shape spans two subtasks' surfaces; splitting it keeps [SL-4]'s
   STOP gate at S1 (where it belongs — 5 of 6 pairs ride on it) without inventing
   an endpoint early.
3. **Hard cap:** the S1 /test session is **the only live external HTTP in the
   whole scope's QA** — budget: the mandatory catch-up fetch round (TC-S1-3), the
   two [SL-4] probe curls (TC-S1-4), and at most ONE optional extra catch-up
   round for the stale-pair re-trigger arm (TC-S1-5b). Every other /test (S2–S5)
   starts the server with `FX_SCHEDULER_ENABLED=false` and makes no external
   call. Rates for S2–S5 = the S1-persisted rows + explicit psql seeds.
4. **Nondeterminism discipline:** live rates are asserted by **plausibility band
   and internal consistency, never exact values** (bands below, G1-corrected).
   Exact-value assertions live only where I control the input (psql-seeded rates,
   hand-pinned goal math).
5. **STOP vs recorded degradation (adopting the plan's split, tightened by P2):**
   - *STOP (pipeline/correctness):* conversion returning WRONG numbers (band
     violation, create-snapshot ≠ /fx/convert for identical inputs, summary
     delta ≠ hand-computed); **any 500 on any no-rate path**; frankfurter
     serving RUB (re-groom D1); boot blocking on provider HTTP; live openapi ≠
     committed; a **silent no-fetch** (empty table AND no catch-up warning in
     logs — that is a wiring bug, not a provider outage).
   - *Recorded degradation (re-run later):* a provider unreachable at /test
     **with** the D3 warning logged and the app healthy — the app surviving it
     IS the design working. The affected TCs go ⏸ blocked, not failed, and are
     re-run when the provider is reachable (they are a mandatory gate before the
     web subtasks start, mirroring the receipts TC-S3-1 deferral precedent).

---

## Preconditions (per subtask; run once at that subtask's /test, keep the shell)

### Environment (shared)
```bash
export BASE=http://localhost:8010
export API=/Users/nikitazaretski/work/budget/apps/api
export ROOT=/Users/nikitazaretski/work/budget
# Live server DB (server reads apps/api/.env → 5443/budget):
psql_q() { PGPASSWORD=budget psql -h localhost -p 5443 -U budget -d budget -tAc "$1"; }
# Migration/DDL DB (S1 alembic Area M targets budget_test, NOT the live budget DB):
export ADB='postgresql+asyncpg://budget:budget@localhost:5443/budget_test'
export TDB='postgresql://budget:budget@localhost:5443/budget_test'
```
> **5443 vs 5433 standing rule (carried from 1.2–2.x):** committed compose maps
> `5433`; live app + all QA psql/alembic target **5443**. Never edit
> `conftest.py`/`docker-compose.yml`/`.env` — env-only setup.

### PC-A — dev API up on 8010 — STOP rule
```bash
curl -s -o /dev/null -w '%{http_code}\n' $BASE/health   # 200 {"status":"ok","database":"ok"}
```
Started by QA. **Scheduler flag discipline:** S1 /test starts it with the
scheduler **enabled** (default) for the live session; **every S2–S5 /test starts
it with `FX_SCHEDULER_ENABLED=false`** (ruling item 3). If the live DB is
pre-`0005`, `alembic upgrade head` first (env setup, not a code change). Not
200 → **STOP**.

### PC-B — two users + tokens + ids (S3/S5)
Mirrors receipts PC-C exactly: form-encoded login, unique per-run emails, capture
`TOKEN_A`, `TOKEN_B`, `A_ID`, `B_ID`, `RUN`; one own expense + one own income
category for A (`A_EXP`, `A_INC`). Default profile base is **RUB** — assumed by
every hand-pinned number below. STOP if any token/id empty.

### PC-C — network reachability (S1 live session ONLY)
```bash
curl -s -o /dev/null -w 'frankfurter %{http_code}\n' https://api.frankfurter.app/latest?base=EUR\&symbols=USD
curl -s -o /dev/null -w 'nbrb %{http_code}\n' "https://api.nbrb.by/exrates/rates/USD?parammode=2"
```
Either unreachable → TC-S1-3/4/5b go ⏸ **blocked (recorded degradation, ruling
5)**, TC-S1-1/2/5a still run. Both reachable → proceed.

### Destructive-schema note (S1 Area M)
TC-S1-1 cycles alembic (`downgrade 0004` → re-`upgrade head`) on **budget_test**
and must own that DB — run with **no pytest session active** (receipts Area M
precedent). TC-S1-3 truncates `exchange_rates` on the **live budget DB** — that
table is scope-new and QA-owned at S1 /test; no user data touched.

---

# TC-S1 — rates-infra-and-migration (tier FULL)

*pytest owns (plan S1 tests 1–9): NBRB derivation/Cur_Scale contrast, inversion +
cross math, payload-date, bad payloads, upsert idempotency, provider isolation,
backfill trigger arms, catch_up_needed, ORM-level CHECKs. My live layer owns the
alembic 0005 lifecycle, DDL-level CHECKs via raw psql (not ORM), and the scope's
ONE real-fetch session: real providers, real scheduler wiring, real boot
catch-up — the exact thing pytest deliberately never touches
(`fx_scheduler_enabled=False` everywhere in the suite).*

### TC-S1-1: alembic 0005 lifecycle on budget_test — up, check, symmetric down, re-up (Area M, destructive)
- **Expected**: `upgrade head` walks `0004 → 0005`; `alembic check` clean;
  `downgrade 0004` drops `exchange_rates`, `goals`, `goal_contributions`, both
  transactions snapshot columns + their three CHECKs; re-`upgrade head` rebuilds;
  `check` clean again.
- **cmd**:
```bash
cd "$API" && DATABASE_URL="$ADB" uv run alembic upgrade head
DATABASE_URL="$ADB" uv run alembic current    # 0005 (head)
DATABASE_URL="$ADB" uv run alembic check      # "No new upgrade operations detected."
psql "$TDB" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_name IN ('exchange_rates','goals','goal_contributions');"  # 3
psql "$TDB" -tAc "SELECT count(*) FROM information_schema.columns WHERE table_name='transactions' AND column_name IN ('base_amount_minor','base_currency');"  # 2
DATABASE_URL="$ADB" uv run alembic downgrade 0004
psql "$TDB" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_name IN ('exchange_rates','goals','goal_contributions');"  # 0
psql "$TDB" -tAc "SELECT count(*) FROM information_schema.columns WHERE table_name='transactions' AND column_name IN ('base_amount_minor','base_currency');"  # 0
DATABASE_URL="$ADB" uv run alembic upgrade head && DATABASE_URL="$ADB" uv run alembic check   # clean
```
- **Status**: ✅ (2026-08-15) `0004→0005` walked, `current`=0005 (head), `check` clean;
  3 tables / 2 tx columns present; downgrade dropped all (0 tables, 0 columns, tx left
  with only its 3 pre-0005 CHECKs); re-upgrade + `check` clean, 3/2 restored. Fully symmetric.

### TC-S1-2: DDL-level CHECKs live in the migrated schema (raw psql, bypassing the ORM)
- **What**: plan S1 test 9 proves the paired-snapshot CHECK and `rate > 0` via
  ORM `IntegrityError`; the migration-produced DDL proof (raw INSERT) is
  live-only (receipts TC-S1-3 precedent). Covers all five scope CHECK families.
- **Expected**: each bad insert rejected naming its constraint; the paired
  NULL/NULL and valid inserts accepted.
- **psql** (budget_test, after TC-S1-1 re-upgrade):
```bash
psql "$TDB" -c "INSERT INTO exchange_rates(base,quote,as_of_date,rate,provider) VALUES ('EUR','USD','2026-08-01',0,'nbrb');" 2>&1 | grep -qi 'rate_positive' && echo "rate>0 live"
psql "$TDB" -c "INSERT INTO exchange_rates(base,quote,as_of_date,rate,provider) VALUES ('eur','USD','2026-08-01',1.1,'nbrb');" 2>&1 | grep -qi 'base_format' && echo "format live"
psql "$TDB" -c "INSERT INTO users(id,email,hashed_password) VALUES ('00000000-0000-0000-0000-0000000000f1','qa-cg@x','x');"
psql "$TDB" -c "INSERT INTO goals(id,user_id,name,target_minor,currency,priority) VALUES (gen_random_uuid(),'00000000-0000-0000-0000-0000000000f1','g',0,'RUB',1);" 2>&1 | grep -qi 'target_minor_positive' && echo "target>0 live"
G=$(psql "$TDB" -tAc "INSERT INTO goals(id,user_id,name,target_minor,currency,priority) VALUES (gen_random_uuid(),'00000000-0000-0000-0000-0000000000f1','g',100,'RUB',1) RETURNING id;")
psql "$TDB" -c "INSERT INTO goal_contributions(id,goal_id,amount_minor,occurred_at) VALUES (gen_random_uuid(),'$G',0,'2026-08-01');" 2>&1 | grep -qi 'nonzero' && echo "<>0 live"
psql "$TDB" -c "INSERT INTO transactions(id,user_id,amount_minor,kind,currency,occurred_at,base_amount_minor) VALUES (gen_random_uuid(),'00000000-0000-0000-0000-0000000000f1',100,'expense','USD','2026-08-01',500);" 2>&1 | grep -qi 'base_snapshot_pair' && echo "pair CHECK live"
psql "$TDB" -c "INSERT INTO transactions(id,user_id,amount_minor,kind,currency,occurred_at,base_amount_minor,base_currency) VALUES (gen_random_uuid(),'00000000-0000-0000-0000-0000000000f1',100,'expense','USD','2026-08-01',500,'RUB');" && echo "paired insert ok"
psql "$TDB" -c "DELETE FROM users WHERE id='00000000-0000-0000-0000-0000000000f1';"   # cascade cleanup (goals+contributions+tx)
```
- **Status**: ✅ (2026-08-15) All five CHECK families rejected at DDL level, each naming its
  constraint: `ck_exchange_rates_rate_positive` (rate=0), `..._base_format`/`..._quote_format`
  (lowercase), `ck_goals_target_minor_positive` (0), `ck_goals_currency_format`,
  `ck_goal_contributions_amount_minor_nonzero` (0), `ck_transactions_base_snapshot_pair`
  (BOTH half-pair directions), `ck_transactions_base_currency_format`,
  `ck_transactions_base_amount_minor_non_negative` (-1). Accepted as expected: valid rate row,
  ±contributions, NULL/NULL tx, paired tx. Cascade delete of the user left 0/0/0.
  *Mechanics adaptation (expectations unchanged):* PG17 has `gen_random_uuid()` built in;
  `psql -tAc "... RETURNING id"` also echoes the `INSERT 0 1` tag, so the goal id was captured
  with `-tAqc ... | head -1`.

### TC-S1-3: THE LIVE FETCH — empty table → boot catch-up populates all 6 canonical pairs with history (the scope's one real external session)
- **What**: the D3/D4 wiring pytest never runs: real `AsyncIOScheduler` start,
  boot catch-up job (`next_run_time=now`), real httpx to frankfurter + NBRB,
  400-day backfill on the emptiness trigger, upsert writes. **Startup must not
  block on the fetch** (D3): `/health` is 200 *before* rows appear.
- **Expected**:
  - server healthy immediately; within ~60–120s `exchange_rates` is populated;
  - exactly the 6 canonical pairs present, **no inverse rows** (D2);
  - `provider` correct per pair: EUR→USD `frankfurter`, other five `nbrb`;
  - history depth ≈ 400 days: `min(as_of_date) <= today - 350`, each pair ≥ 100
    rows (loose — publication-calendar dependent);
  - **plausibility bands (G1-corrected — see Gaps):** stored `rate` is
    *quote-per-one-base* (D1 convention), so:
    EUR→USD ∈ [0.9, 1.3]; **BYN→RUB ∈ [20, 40]** (RUB per 1 BYN — NOT the
    plan's "0.02–0.05", which is the intermediate `b(RUB)`; the `Cur_Scale`-
    ignored bug lands ≈ 0.2–0.4, i.e. 100× BELOW this band);
    RUB→USD ∈ [0.008, 0.02]; BYN→USD ∈ [0.2, 0.5].
- **cmd**:
```bash
psql_q "TRUNCATE exchange_rates"           # re-arm the D4 emptiness trigger (the documented mechanism)
cd "$API" && uv run uvicorn budget_api.app:create_app --factory --port 8010 &   # scheduler ENABLED (default)
sleep 2; curl -s -o /dev/null -w 'boot health %{http_code}\n' $BASE/health      # 200 BEFORE rows exist (D3 non-blocking)
sleep 90
psql_q "SELECT base||'>'||quote||' '||provider||' n='||count(*)||' min='||min(as_of_date)||' last='||max(rate) FROM exchange_rates GROUP BY base,quote,provider ORDER BY 1"
psql_q "SELECT count(*) FROM (SELECT DISTINCT base,quote FROM exchange_rates) p WHERE (base,quote) NOT IN (('EUR','USD'),('BYN','USD'),('BYN','EUR'),('BYN','RUB'),('RUB','USD'),('RUB','EUR'))"   # 0 — no inverse/extra pairs
# band checks (latest row per pair):
psql_q "SELECT rate BETWEEN 0.9 AND 1.3 FROM exchange_rates WHERE base='EUR' AND quote='USD' ORDER BY as_of_date DESC LIMIT 1"     # t
psql_q "SELECT rate BETWEEN 20 AND 40 FROM exchange_rates WHERE base='BYN' AND quote='RUB' ORDER BY as_of_date DESC LIMIT 1"       # t  (Cur_Scale plausibility, [SL-4].2)
psql_q "SELECT rate BETWEEN 0.008 AND 0.02 FROM exchange_rates WHERE base='RUB' AND quote='USD' ORDER BY as_of_date DESC LIMIT 1"  # t
psql_q "SELECT min(as_of_date) <= current_date - 350 FROM exchange_rates"                                                          # t (backfill depth)
```
- **STOP**: any band violated (esp. BYN→RUB ≈ 0.2–0.4 = the Cur_Scale bug);
  rows appear for an inverse pair; health blocked on fetch; silent no-fetch
  (empty table + no warning log). Provider down WITH warning logged → ⏸
  degradation (ruling 5), re-run when reachable.
- **Status**: ✅ (2026-08-15, run month Aug-2026; live DB was pre-0005 → `alembic upgrade head`
  per PC-A, then TRUNCATE) **No STOP triggered.**
  - D3 non-blocking: `/health` 200 at t+3s with `count(*)=0`; rows appeared by t+13s.
  - Exactly 6 canonical pairs, **0 non-canonical/inverse pairs**, 1 provider per pair:
    `EUR>USD frankfurter n=280 max=2026-08-14` (ECB business days; 08-15 is a Saturday),
    `BYN>EUR|BYN>RUB|BYN>USD|RUB>EUR|RUB>USD nbrb n=401 each, max=2026-08-15`. Total 2285.
  - Depth: `min(as_of_date)=2025-07-11` = today−400 ≤ today−350 ✅; every pair ≥ 100 rows.
  - **Bands (all t):** EUR>USD `1.15670000` ∈[0.9,1.3]; **BYN>RUB `27.87922719` ∈[20,40]**
    (Cur_Scale handled — the ignored-scale bug would land ≈0.28); RUB>USD `0.01204871`
    ∈[0.008,0.02]; BYN>USD `0.33590863` ∈[0.2,0.5]. (BYN>EUR `0.29123103`, RUB>EUR `0.01044617`.)
  - Internal consistency spot: BYN>USD ÷ BYN>RUB = 0.012049 = RUB>USD ✅; BYN>USD ÷ BYN>EUR
    = 1.1534 vs frankfurter EUR>USD 1.1567 (NBRB cross vs ECB, ~0.3% — plausible).
  - Both unverified-in-pytest NBRB shapes (`?parammode=2`, `/dynamics/{cur_id}`) parsed on the
    real wire; `Date`/`Cur_Date` key handling produced correct effective dates.
  - **Log note (not a STOP):** no `fx backfill` INFO line in the server log. Verified this is a
    log-config artifact, not a wiring gap — uvicorn's default `LOGGING_CONFIG` gives the root
    logger no handler, so app INFO is dropped while WARNING still surfaces via `lastResort`
    (reproduced: emitting INFO+WARNING on `budget_api.services.fx_jobs` under that config
    prints only the WARNING). P2's rule stays enforceable; the 400-day backfill itself is
    proven by the 401-row/pair history. No warnings logged in any run (both providers healthy).

### TC-S1-4: [SL-4] frankfurter-RUB probe — same session, STOP gate for D1
- **What**: D1's load-bearing assumption: ECB/frankfurter has NO RUB (else the
  whole NBRB-cross derivation for 5 pairs is the wrong design).
- **Expected**: EUR→USD probe 200 with a `rates.USD` number; the RUB probe
  returns an error / RUB absent from the currency list.
- **curl** (the only two QA-initiated external calls in the scope):
```bash
curl -s "https://api.frankfurter.app/latest?base=EUR&symbols=USD"    # 200, rates.USD present
curl -s "https://api.frankfurter.app/latest?base=EUR&symbols=RUB"    # error / RUB absent
curl -s "https://api.frankfurter.app/currencies" | grep -c '"RUB"'   # 0
```
- **STOP**: frankfurter DOES serve RUB → **STOP, re-groom D1** (per [SL-4].1).
- **Status**: ✅ (2026-08-15) **STOP gate NOT triggered — D1 holds.** `?symbols=USD` → 200
  `{"amount":1.0,"base":"EUR","date":"2026-08-14","rates":{"USD":1.1567}}`; `?symbols=RUB` →
  **404 `{"message":"not found"}`**; `/currencies` → 30 codes, `"RUB"` absent (grep count 0).
  *PC-C mechanics note:* `api.frankfurter.app` now answers **301 → `api.frankfurter.dev/v1/...`**
  (params preserved). Not a defect: `FxRateFetcher` builds its client with
  `follow_redirects=True` (fx_rates.py:241), and the live fetch in TC-S1-3 succeeded through
  the redirect. QA probes therefore use `curl -sL`; a bare `curl` reports 301, not 200.

### TC-S1-5: boot catch-up trigger — negative arm (free) + optional stale-pair re-trigger
- **What**: `catch_up_needed` wiring live. Upsert convergence itself is pytest
  test 5; the live value is the boot decision on a real server.
- **(a) negative arm — zero extra HTTP:** restart the API (table fresh from
  TC-S1-3) → catch-up must NOT fire: row count and `max(fetched_at)` unchanged
  after 30s, no fetch log line.
- **(b) positive arm — OPTIONAL, costs the session's one extra fetch round:**
  `psql_q "DELETE FROM exchange_rates WHERE base='BYN' AND quote='EUR' AND as_of_date >= current_date - 3"`
  → restart → catch-up fires (one stale pair triggers, D3); pair recent again;
  other pairs' history counts unchanged (latest-mode, not a re-backfill —
  pinning plan test 7's arm on the live wire); PK guarantees no duplicates.
- **cmd** (a):
```bash
kill %1; cd "$API" && uv run uvicorn budget_api.app:create_app --factory --port 8010 &
BEFORE=$(psql_q "SELECT count(*)||'|'||max(fetched_at) FROM exchange_rates"); sleep 30
AFTER=$(psql_q "SELECT count(*)||'|'||max(fetched_at) FROM exchange_rates"); [ "$BEFORE" = "$AFTER" ] && echo "no-op catch-up OK"
```
- **Note**: the daily 17:30 UTC cron itself is NOT waited for — the catch-up
  path exercises the same `fetch_daily_rates` through the same scheduler; the
  cron registration is design-verified (pytest covers the job function; the
  trigger time is config echo, vacuous to test).
- **Status**: ✅ (2026-08-15) **(a) negative arm:** restart → after 30s
  `BEFORE = AFTER = 2285|2026-08-15 15:27:27.926855+00` (count AND max(fetched_at) identical) →
  no-op catch-up, zero external HTTP, no fx log lines. (`CATCH_UP_LAG_DAYS=3` correctly
  tolerates frankfurter's 08-14 max on a Saturday.)
  **(b) positive arm (the session's one allowed extra fetch round):** deleted BYN>EUR
  `as_of_date >= today−3` (401→397, max 2026-08-11) → restart → catch-up fired: BYN>EUR
  **397→398, max back to 2026-08-15**, rate `0.29123103` byte-identical to the pre-delete value
  (idempotent upsert). **Latest-mode, not a re-backfill:** only today's row was written — the
  08-12..08-14 gap stayed empty and every other pair's count was unchanged
  (401/401/280/401/401). 0 duplicate (base,quote,as_of_date) rows. No warnings logged.
  *Artifact left for S2–S5:* live table now 2282 rows with a QA-induced 3-day BYN>EUR hole
  (08-12..08-14); harmless — nearest-previous lookup resolves those dates to 08-11, and no
  pinned TC uses BYN>EUR on those dates. Rates preserved (not truncated) for S2–S5.

---

# TC-S2 — fx-domain-and-preview (tier FULL)

*pytest owns (plan S2 tests 1–10): cross-exponent math, HALF_UP boundary,
zero-minor, invert precision, direct/inverse/nearest-previous/no-rate/identity
endpoint paths with seeded rates, one auth test, the exponent-sync guard. My
live layer owns: the real-rate `/fx/convert` half of the live check (P1), the
curl-owned Pydantic 422 pack, the 401 wall on the wire, and live==committed
contract shape. Server: `FX_SCHEDULER_ENABLED=false`; rates = S1-persisted rows.*

### TC-S2-1: 401 wall on /fx (one per new router)
- **curl**: `curl -s -o /dev/null -w '%{http_code}\n' "$BASE/fx/convert?amount_minor=100&from=USD&to=RUB"` → **401**.
- **Status**: ✅ (2026-08-15) No token → **401** `{"detail":"Unauthorized"}`. Extra arm:
  garbage bearer (`Bearer not.a.token`) → **401** too. Wall is up before validation runs
  (a valid-shaped query still 401s), so the router is behind the shared auth dependency.

### TC-S2-2: Pydantic pattern/bounds 422 pack (curl-owned per grooming split)
- **What**: auto-Pydantic arms pytest deliberately excludes. All → `422` with
  `HTTPValidationError` shape (`detail: [{loc, msg, type}]`), never 500.
- **curl**:
```bash
H="Authorization: Bearer $TOKEN_A"
curl -s -o /dev/null -w 'lowercase %{http_code}\n' -H "$H" "$BASE/fx/convert?amount_minor=100&from=usd&to=RUB"        # 422 (pattern)
curl -s -o /dev/null -w '4letter   %{http_code}\n' -H "$H" "$BASE/fx/convert?amount_minor=100&from=USDD&to=RUB"       # 422
curl -s -o /dev/null -w 'missing   %{http_code}\n' -H "$H" "$BASE/fx/convert?amount_minor=100&from=USD"               # 422 (to required)
curl -s -o /dev/null -w 'negative  %{http_code}\n' -H "$H" "$BASE/fx/convert?amount_minor=-1&from=USD&to=RUB"         # 422 (ge=0)
curl -s -o /dev/null -w 'badmonth  %{http_code}\n' -H "$H" "$BASE/fx/convert?amount_minor=100&from=USD&to=RUB&date=2026-13-01"  # 422
curl -s -H "$H" "$BASE/fx/convert?amount_minor=100&from=usd&to=RUB" | grep -q '"loc"' && echo "validation shape ok"
```
- **Status**: ✅ (2026-08-15) All five arms **422**, none 500: lowercase 422, 4-letter 422,
  missing `to` 422, `amount_minor=-1` 422 (ge=0), `date=2026-13-01` 422. Shape is
  `HTTPValidationError`: `{"detail":[{"type":"string_pattern_mismatch","loc":["query","from"],
  "msg":"String should match pattern '^[A-Z]{3}$'","input":"usd","ctx":{...}}]}` — note `loc`
  reports the **wire alias `from`**, not the Python-side name, so client-side field mapping works.

### TC-S2-3: /fx/convert against a REAL stored rate (the deferred half of the live check — P1)
- **What**: real S1 rates, real inversion path (USD→RUB rides `1/rate(RUB→USD)`
  — the day-one RUB-base path, D2), disclosure of `rate_as_of`, and internal
  arithmetic consistency against the echoed rate string.
- **Expected**: 200; `rate_as_of` ≤ today and ≥ today−7 (fresh fetch);
  `converted_minor` plausible for 1000.00 USD → RUB: **[6000000, 12000000]**
  (60k–120k RUB); and `converted_minor == round(amount_minor × rate)` recomputed
  from the response's own `rate` string (both exp 2 — one multiply; a mismatch =
  two conversion implementations = STOP).
- **curl**:
```bash
R=$(curl -s -H "Authorization: Bearer $TOKEN_A" "$BASE/fx/convert?amount_minor=100000&from=USD&to=RUB")
echo "$R" | python3 -c '
import sys, json, decimal
d = json.load(sys.stdin)
rate = decimal.Decimal(d["rate"])
expect = int((decimal.Decimal(100000) * rate).quantize(1, rounding=decimal.ROUND_HALF_UP))
print({"converted": d["converted_minor"], "recomputed": expect,
       "match": d["converted_minor"] == expect,
       "band_ok": 6_000_000 <= d["converted_minor"] <= 12_000_000,
       "as_of": d["rate_as_of"], "from": d["from"], "to": d["to"]})'
```
- **Note**: displayed `rate` is quantized 1E-8 while internal math uses full
  precision — recomputed-vs-returned may differ by ±1 minor unit at most;
  |diff| ≤ 1 passes, more = STOP.
- **Status**: ✅ (2026-08-15, server `FX_SCHEDULER_ENABLED=false`, zero external HTTP)
  **No STOP triggered.** 1000.00 USD → RUB:
  `{"converted_minor":8299644,"rate":"82.99643696","rate_as_of":"2026-08-15","from":"USD",
  "to":"RUB","amount_minor":100000}`.
  - **Band:** 8 299 644 (82 996.44 RUB) ∈ [6 000 000, 12 000 000] ✅.
  - **Arithmetic consistency:** recomputed from the response's own rate string = 8299644,
    **diff 0** (not even the tolerated ±1) → one conversion implementation ✅.
  - **Inversion path proven live (D2):** no `USD>RUB` row exists; stored `RUB>USD` @2026-08-15
    is `0.01204871`, and `1/0.01204871 = 82.99643696296…` → displayed `rate` `82.99643696` is
    exactly that quantized to 1E-8. So USD→RUB really did ride `1/rate(RUB→USD)`.
  - **Freshness:** `rate_as_of` 2026-08-15 = today ∈ [today−7, today] ✅.
  - **Nearest-previous disclosed honestly (extra arm over S1's QA-induced BYN>EUR hole):**
    `date=2026-08-11` → 0.29201343 as_of 08-11; `date=2026-08-13` (inside the 08-12..08-14 hole)
    → same 0.29201343 but `rate_as_of` **08-11, not the requested 08-13** — the endpoint reports
    the stored row's real date rather than pretending it has one for the asked day;
    `date=2026-08-15` → 0.29123103 as_of 08-15. Expected S1 artifact behaviour, not a defect.

### TC-S2-4: degradation + identity live — no-rate is 200-null, never 404/500
- **Expected**: unstored pair (GBP not fetched) → `200` with the all-null triple
  (`converted_minor`, `rate`, `rate_as_of` all null); `from==to` → echo
  `converted_minor == amount_minor`, `rate` "1".
- **curl**:
```bash
curl -s -H "Authorization: Bearer $TOKEN_A" "$BASE/fx/convert?amount_minor=5000&from=GBP&to=RUB" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(all(d[k] is None for k in ("converted_minor","rate","rate_as_of")))'   # True
curl -s -H "Authorization: Bearer $TOKEN_A" "$BASE/fx/convert?amount_minor=5000&from=RUB&to=RUB" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["converted_minor"]==5000)'   # True
```
- **Status**: ✅ (2026-08-15) **No STOP triggered — no-rate never 404/500.**
  - Unstored pair: `GBP→RUB` → **200** `{"converted_minor":null,"rate":null,"rate_as_of":null,
    "from":"GBP","to":"RUB","amount_minor":5000}` — all-null triple, request echo intact ✅.
  - Identity: `RUB→RUB` → 200, `converted_minor==5000` ✅.
  - Two extra no-rate arms (D7/D8 gate is "any 500 on any no-rate path = STOP"): pre-history
    `date=1990-01-01` on a real pair → **200** all-null (not a 404, not a 500); both-unstored
    `GBP→JPY` → **200**. Server log has 0 tracebacks and 0 5xx for the whole session.
  - *Expectation-wording deviation (not a defect):* identity `rate` is **`"1.00000000"`**, not the
    literal `"1"` the TC text wrote — same value, and it matches the 1E-8 display quantization
    every other rate uses (`FxConvertRead.rate` is a decimal STRING by contract), so it is
    consistent rather than special-cased. Identity also echoes the requested date in
    `rate_as_of` (`date=2020-01-01` → `rate_as_of:"2020-01-01"`), which is honest for a rate
    that holds on every date.

### TC-S2-5: contract — live /openapi.json == committed; `from` param literal
- **Expected**: `/fx/convert` has `get`; query params include one **named
  literally `from`** (in: query) plus `to`, `amount_minor`, `date`;
  `FxConvertRead` component present; live deep-equals committed
  `apps/api/openapi.json` (python3 deep-compare, receipts style); generated
  `schema.d.ts` carries the literal `from` key ([SL-1] regen line is the
  /implement report's — I confirm it landed).
- **Status**: ✅ (2026-08-15) **No contract drift.** python3 deep-compare of live
  `GET /openapi.json` vs committed `apps/api/openapi.json` → **True** (whole document, not just
  the fx subtree) — the regen landed.
  - `/fx/convert` has exactly `['get']`; responses `200` + `422`.
  - Query params, all `in: query`: **`from`** (required, `pattern ^[A-Z]{3}$`) — the literal
    alias survives Pydantic→OpenAPI despite `from` being a Python keyword — plus `to` (same
    pattern), `amount_minor` (integer, `minimum: 0`), `date` (optional `anyOf[date, null]`).
  - `FxConvertRead` component present; all six fields **required**, with
    `converted_minor`/`rate`/`rate_as_of` each `anyOf[…, null]` — i.e. the null triple is part
    of the declared contract, so clients must handle it (they can't be surprised by a missing key).
  - Generated client `packages/api-client/src/generated/schema.d.ts` carries the literal key
    under `operations.convert_fx_convert_get.parameters.query`: `amount_minor: number; from:
    string; to: string; date?: string | null;` — plus the `FxConvertRead` type with
    `converted_minor: number | null`, `rate: string | null`, `rate_as_of: string | null`.

---

# TC-S3 — tx-snapshot-and-aggregates (tier FULL)

*pytest owns (plan S3 tests 1–16): the full create/PATCH decision tables with
seeded rates, override-wins, both no-rate create arms, summary buckets 1–3 +
flag + stale-base fallback + backward-compat pin. My live layer owns the
cross-request lifecycle journeys (state observed via GET across requests, real
rates), the cross-endpoint consistency invariant (create's auto-snapshot ==
/fx/convert — ONE conversion implementation, D8), the summary before/after-rate
flip, the recompute-to-miss arm (Gap G2 — unpinned in pytest), pattern 422s, and
contract shape. Server: `FX_SCHEDULER_ENABLED=false`. No new 401 TC — the
transactions router's auth wall predates this scope.*

### TC-S3-1: foreign-tx lifecycle — auto-snapshot == /fx/convert, then PATCH-to-base clears
- **What**: cross-request: POST → GET → PATCH → GET. The equality against
  /fx/convert (same amount/currencies/date) is the live proof there is ONE
  conversion implementation.
- **Expected**: POST `currency:"USD", amount_minor:100000, occurred_at:<D>` →
  `201`, `base_currency=="RUB"`, `base_amount_minor` == `/fx/convert
  ?amount_minor=100000&from=USD&to=RUB&date=<D>`.converted_minor (exact); PATCH
  `{"currency":"RUB"}` → GET: snapshot `null/null`, `amount_minor` untouched
  ([SL-2] headline case on the wire).
- **curl**:
```bash
D=2026-08-10
T=$(curl -s -X POST $BASE/transactions -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' \
  -d "{\"amount_minor\":100000,\"kind\":\"expense\",\"category_id\":\"$A_EXP\",\"occurred_at\":\"$D\",\"currency\":\"USD\"}")
TID=$(echo "$T" | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')
CONV=$(curl -s -H "Authorization: Bearer $TOKEN_A" "$BASE/fx/convert?amount_minor=100000&from=USD&to=RUB&date=$D" | python3 -c 'import sys,json; print(json.load(sys.stdin)["converted_minor"])')
echo "$T" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['base_currency']=='RUB' and d['base_amount_minor']==$CONV)"   # True
curl -s -o /dev/null -X PATCH $BASE/transactions/$TID -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' -d '{"currency":"RUB"}'
curl -s $BASE/transactions/$TID -H "Authorization: Bearer $TOKEN_A" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["base_amount_minor"] is None and d["base_currency"] is None and d["amount_minor"]==100000)'   # True
```
- **Status**: ⏸

### TC-S3-2: override journey — override wins → explicit-null un-overrides → note-PATCH keeps
- **What**: cross-request pin of PATCH rows 4/5/7 + Disagreement §2 semantics.
- **Expected**: POST USD tx with explicit `base_amount_minor: 7777777` → stored
  byte-for-byte (≠ auto value from TC-S3-1's CONV); PATCH
  `{"base_amount_minor": null}` → GET: snapshot == the AUTO value (recomputed,
  not cleared — the un-override affordance); PATCH `{"note":"x"}` → snapshot
  byte-identical (row 7).
- **curl**: as TC-S3-1 shape; assertions:
  after create `base_amount_minor==7777777`; after null-PATCH
  `base_amount_minor==$CONV` (non-null!); after note-PATCH unchanged.
- **Status**: ⏸

### TC-S3-3: recompute-to-miss — PATCH `occurred_at` to a pre-history date clears the snapshot (G2 live pin)
- **What**: the unpinned arm of PATCH row 6: recompute whose `lookup_rate`
  MISSES must null the snapshot, not keep the stale value and not 500.
- **Expected**: foreign tx with populated snapshot; PATCH
  `{"occurred_at":"1990-01-01"}` (before any backfill row) → `200`; GET:
  snapshot `null/null` (D7 degradation via the PATCH path).
- **curl**: create as TC-S3-1 → PATCH occurred_at → GET assert null pair.
- **Status**: ⏸

### TC-S3-4: summary before/after a rate — the bucket-3 flip with exact delta
- **What**: cross-request D9 journey pytest can't sequence live: an unconverted
  row becomes converted when a rate appears (psql seed — no external HTTP).
- **Expected**: POST GBP expense `amount_minor: 5000` dated 2026-08-10 →
  `GET /transactions/summary?month=2026-08`: `unconverted_count == 1`, expense
  total EXCLUDES it; psql-seed GBP→RUB rate `100.00000000` @ 2026-08-08 →
  summary again: `unconverted_count == 0`, expense total moved by **exactly
  +500000** (50.00 GBP × 100 = 5000.00 RUB; both exp 2).
- **curl/psql**:
```bash
curl -s -o /dev/null -X POST $BASE/transactions -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' \
  -d "{\"amount_minor\":5000,\"kind\":\"expense\",\"category_id\":\"$A_EXP\",\"occurred_at\":\"2026-08-10\",\"currency\":\"GBP\"}"
S1=$(curl -s -H "Authorization: Bearer $TOKEN_A" "$BASE/transactions/summary?month=2026-08")
psql_q "INSERT INTO exchange_rates(base,quote,as_of_date,rate,provider) VALUES ('GBP','RUB','2026-08-08',100.00000000,'nbrb') ON CONFLICT (base,quote,as_of_date) DO UPDATE SET rate=EXCLUDED.rate"
S2=$(curl -s -H "Authorization: Bearer $TOKEN_A" "$BASE/transactions/summary?month=2026-08")
python3 - "$S1" "$S2" <<'EOF'
import sys, json
a, b = json.loads(sys.argv[1]), json.loads(sys.argv[2])
print({"before_flag": a["unconverted_count"], "after_flag": b["unconverted_count"],
       "delta_expense": b["expense_minor"] - a["expense_minor"]})   # 1, 0, 500000
EOF
psql_q "DELETE FROM exchange_rates WHERE base='GBP'"   # cleanup: keep live table canonical-only
```
- **Status**: ⏸

### TC-S3-5: pattern 422 pack on transactions (curl-owned)
- **curl**: create with `"currency":"usd"` → 422; `"currency":"USDD"` → 422;
  `"base_amount_minor":0` (ge=1) → 422 — all `HTTPValidationError`-shaped
  (business 422s like `BASE_AMOUNT_WITHOUT_CURRENCY` are pytest's). Also one
  create with **explicit `"base_amount_minor": null` + foreign currency** → 201
  behaves as omitted (the plan's stated create equivalence — cheap wire pin).
- **Status**: ⏸

### TC-S3-6: contract — live == committed (SummaryRead/TransactionRead deltas)
- **Expected**: `SummaryRead` has REQUIRED `unconverted_count`; `TransactionRead`
  has nullable `base_amount_minor`/`base_currency`; Create/Update carry
  `currency` + `base_amount_minor`; live deep-equals committed; drift tests
  green in TC-Z1.
- **Status**: ⏸

---

# TC-S4 — goals-domain (tier FULL) — no live layer

*Pure module (stdlib + decimal + datetime), no endpoint, no DB, no wire. The
entire D11 edge matrix is plan S4 tests (a)–(u) in pytest — my /test for S4 is
**TC-Z1 only** (full suite green, including `test_goals_domain.py`). Inventing a
live TC here would assert nothing pytest doesn't already prove (receipts "what I
do NOT test" discipline).*

- **Status**: ⏸ (TC-Z1 at S4 /test)

---

# TC-S5 — goals-api (tier FULL)

*pytest owns (plan S5 tests 1–16): CRUD mechanics, atomic initial-saved, priority
default/ordering, no-oracle unit paths, computed-math fixtures, [SL-3] per-goal
vs top-level flags, contribution invariant boundaries, progress series. My live
layer owns: the 401 wall, the curl 422/bounds pack, the end-to-end goals journey
with ONE fully hand-pinned response (real server, real DB, cross-request state),
the no-oracle WIRE BYTES (diff-empty), the [SL-3] spot on real rates, single-goal
GET consistency (Gap G5 — unpinned in pytest), and contract shape. Server:
`FX_SCHEDULER_ENABLED=false`; rates = S1 rows.*

### TC-S5-1: 401 wall on /goals (one per new router + one nested spot)
- **curl**: `GET /goals` no token → 401; `POST /goals/<uuid>/contributions` no
  token → 401.
- **Status**: ⏸

### TC-S5-2: Pydantic 422/bounds pack (curl-owned)
- **curl** (all → 422 validation shape, never 500):
```bash
H="Authorization: Bearer $TOKEN_A"; CT='Content-Type: application/json'
curl -s -o /dev/null -w 'cur %{http_code}\n'    -X POST $BASE/goals -H "$H" -H "$CT" -d '{"name":"g","target_minor":100,"currency":"rub"}'    # 422 pattern
curl -s -o /dev/null -w 'tgt %{http_code}\n'    -X POST $BASE/goals -H "$H" -H "$CT" -d '{"name":"g","target_minor":0,"currency":"RUB"}'      # 422 ge=1
curl -s -o /dev/null -w 'lim0 %{http_code}\n'   -H "$H" "$BASE/goals/$GID/contributions?limit=0"      # 422 (ge=1)
curl -s -o /dev/null -w 'lim201 %{http_code}\n' -H "$H" "$BASE/goals/$GID/contributions?limit=201"    # 422 (le=200)
curl -s -o /dev/null -w 'mon0 %{http_code}\n'   -H "$H" "$BASE/goals/$GID/progress?months=0"          # 422 (ge=1)
curl -s -o /dev/null -w 'mon61 %{http_code}\n'  -H "$H" "$BASE/goals/$GID/progress?months=61"         # 422 (le=60)
curl -s -o /dev/null -w 'uuid %{http_code}\n'   -H "$H" "$BASE/goals/not-a-uuid"                      # 422 (path param, auto arm)
```
- **Status**: ⏸

### TC-S5-3: THE GOALS JOURNEY — hand-pinned realism math, contribute/withdraw boundary, progress series
- **What**: end-to-end against a FRESH run-scoped user (no other tx — the pin
  depends on it). One full expected `GoalListRead` hand-computed and pinned.
- **Setup — seeded 3-month history** (6 POSTs, base RUB, dated in the 3 FULL
  months before the run month; instance below assumes an **Aug-2026 run** —
  window [2026-05-01, 2026-08-01)):
  - per month 2026-05/06/07 (day 10): income `10000000` (100 000.00) + expense
    `7000000` (70 000.00) → free = (30000000 − 21000000) // 3 = **3000000**.
- **Goal create**: `{"name":"vacation","target_minor":12000000,"currency":"RUB",
  "deadline":"2026-12-31","initial_saved_minor":2000000}` → 201.
- **PINNED `GET /goals` response** (hand-computed, exact — recompute via the D11
  formulae if the run month ≠ Aug 2026):
  - top-level: `free_balance_minor == 3000000`, `realism_unavailable == false`;
  - item: `saved_minor == 2000000`, `completed == false`,
    `monthly_needed_minor == 2500000` (ceil(10000000/4), months_until(Aug 15 →
    Dec 31) = 4), `realistic == true` (2500000 ≤ 3000000),
    `months_to_target == 4` (ceil(10000000/3000000)),
    `suggested_deadline == "2026-12-15"` (+4 months),
    `allocated_monthly_minor == 2500000` (waterfall, single goal),
    `realism_unavailable == false`.
- **G5 pin**: `GET /goals/{id}` returns the IDENTICAL computed fields as the
  list item (whole-portfolio assembler — the plan's own "computing against one
  goal would lie" invariant, unpinned in pytest).
- **Current-month exclusion spot** (plan test 8's live twin, cheap): POST income
  `99000000` dated **today** → `GET /goals`: `free_balance_minor` still
  `3000000`. Delete that tx.
- **Contributions + boundary**:
  - `POST .../contributions {"amount_minor":1000000,"occurred_at":"2026-06-10"}` → 201
  - `POST {"amount_minor":-500000,"occurred_at":"2026-07-10"}` → 201 (saved now 2500000)
  - `POST {"amount_minor":-2500000}` → **201** (withdraw to exactly zero — boundary)
  - `POST {"amount_minor":-1}` → **422 `{"detail":"CONTRIBUTION_EXCEEDS_SAVED"}`**
  - `POST {"amount_minor":0}` → 422 (validator)
  - `DELETE .../contributions/<the +1000000 row>` (saved is 0) → **422** (would push SUM < 0)
  - `DELETE .../contributions/<the −2500000 row>` → **204** (restores 2500000)
- **PINNED progress** `GET /goals/{id}/progress?months=4` (after the deletes;
  remaining rows: initial +2000000 @today, +1000000 @06-10, −500000 @07-10):
  `2026-05 {0, 0}`, `2026-06 {+1000000, 1000000}`, `2026-07 {−500000, 500000}`,
  `2026-08 {+2000000, 2500000}` — empty May present with zeros (chart-ready).
- **Status**: ⏸

### TC-S5-4: no-oracle 404s — byte-identical wire bodies (SECURITY, must be live)
- **What**: foreign vs missing, receipts TC-S2-6/S4-3 style — `diff` of full
  body+status captures.
- **Expected**:
  - B `GET /goals/$GID` (A's goal) vs B `GET /goals/$RAND` → both
    `404 {"detail":"GOAL_NOT_FOUND"}`, **diff empty**; same for PATCH, DELETE,
    and `POST /goals/{id}/contributions` (all four verbs of the wall);
  - contribution no-oracle: A's own second goal `GID2`;
    `DELETE /goals/$GID2/contributions/$CID_OF_GID1` (wrong own goal) vs
    `DELETE /goals/$GID2/contributions/$RAND` → both
    `404 {"detail":"CONTRIBUTION_NOT_FOUND"}`, **diff empty** (the fresh
    wrong-goal path).
- **curl**:
```bash
RAND=$(uuidgen|tr A-F a-f)
curl -s -w '\n%{http_code}\n' $BASE/goals/$GID  -H "Authorization: Bearer $TOKEN_B" > /tmp/g_x.txt
curl -s -w '\n%{http_code}\n' $BASE/goals/$RAND -H "Authorization: Bearer $TOKEN_B" > /tmp/g_m.txt
diff /tmp/g_x.txt /tmp/g_m.txt && echo "GOAL BYTE-IDENTICAL"
curl -s -w '\n%{http_code}\n' -X DELETE $BASE/goals/$GID2/contributions/$CID1 -H "Authorization: Bearer $TOKEN_A" > /tmp/c_x.txt
curl -s -w '\n%{http_code}\n' -X DELETE $BASE/goals/$GID2/contributions/$RAND -H "Authorization: Bearer $TOKEN_A" > /tmp/c_m.txt
diff /tmp/c_x.txt /tmp/c_m.txt && echo "CONTRIB BYTE-IDENTICAL"
```
- **Cross-user FX note (explicit, per mandate):** `exchange_rates` is **global,
  user-less data** — there is no per-user FX surface and therefore no cross-user
  FX test to write; `/fx/convert` exposes only public market rates behind the
  401 wall (TC-S2-1). Stated so it's a decision, not an omission.
- **Status**: ⏸

### TC-S5-5: [SL-3] on real rates — foreign goal converts; exotic goal degrades in isolation
- **What**: live spot of plan tests 10/11 with REAL S1 rates instead of seeds.
- **Expected**: a USD goal (target `100000` = $1000) under RUB base →
  `realistic` non-null, `monthly_needed_minor` in USD,
  `allocated_monthly_minor` in RUB (base) and > 0 while free balance covers it;
  a JPY goal (no rate fetched for JPY) → THAT item `realism_unavailable ==
  true`, null realism fields, `allocated_monthly_minor == 0`; the USD/RUB
  goals' numbers unchanged by its presence; **top-level flag stays false**;
  never a 500.
- **Status**: ⏸

### TC-S5-6: contract — live == committed (full /goals surface)
- **Expected**: all 8 routes present (`/goals` GET/POST, `/goals/{id}`
  GET/PATCH/DELETE, contributions POST/GET/DELETE, `/goals/{id}/progress` GET);
  422s declared as the anyOf union `GoalError` + `HTTPValidationError` (auto
  arm never suppressed — receipts V2/AM-5); live deep-equals committed; drift
  tests green in TC-Z1.
- **Status**: ⏸

---

## TC-Z1 (every subtask /test): full pytest suite green
`cd $API && TEST_DATABASE_URL=postgresql+asyncpg://budget:budget@localhost:5443/budget_test uv run pytest`
— confirms Section A (the plan's per-subtask pytest lists) passes. Any failure →
capture, do NOT fix backend code, escalate to senior-lead.

- **S1 run (2026-08-15): ✅ 123 passed in 22.71s**, 0 failed — incl. `test_fx_rates.py` (10)
  and `test_fx_jobs.py` (11). Run BEFORE the destructive Area M step; no pytest session was
  active during TC-S1-1/2.
- **S2 run (2026-08-15): ✅ 136 passed in 22.14s**, 0 failed / 0 errors — +13 over S1, matching
  the three new S2 suites (`test_fx_domain.py`, `test_fx_convert.py`,
  `test_currency_exponents_sync.py`). Section A for S2 is green; no escalation needed.

---

## What I explicitly do NOT test (and why)

- **Anything the mocked-seam pytest already proves** — parse/derivation math,
  upsert idempotency unit semantics, the PATCH decision table rows, D11 edge
  matrix, summary bucket fixtures, `model_fields_set` mechanics. My live TCs
  exist for real-infra and cross-request value, not re-assertion.
- **Exact live rate values** — nondeterministic market data; bands + internal
  consistency only (ruling 4).
- **The daily 17:30 UTC cron firing** — waiting for wall-clock cron is not a
  sane test; the boot catch-up path drives the same job function through the
  same scheduler (TC-S1-3/5), and the trigger time is config echo.
- **NBRB/frankfurter payload-shape edge cases live** — pytest owns parsing with
  canned documents; the live session proves the real shapes parse at all.
- **FOR-UPDATE contribution race live** — same verdict as the plan: two
  interleaved live curls prove nothing reliably; review-verified.
- **Web journeys (3.5)** — web-qa owns them (lightweight STANDARD checklists in
  plan-web's flow); my API TCs underwrite the codes/shapes.
- **Base-currency-change flows** — no profile-base-change endpoint exists in
  this scope; the stale-snapshot fallback is pinned by pytest S3 test 15 via
  seeded rows (nothing live to drive it with).

---

## Gaps found in plan.md test plans (numbered — for senior-lead)

- **G1 — [SL-4].2 plausibility band is INVERTED as written.** Plan says stored
  BYN→RUB "≈ 0.02–0.05 range, not 100× off". Under the D1 convention (rate =
  quote per 1 base; BYN→RUB = `1/b(RUB)`), the correct stored value is ≈ **25–35
  RUB per BYN**; 0.02–0.05 is the *intermediate* `b(RUB)` (BYN per 1 RUB). The
  `Cur_Scale`-ignored bug produces ≈ 0.2–0.4 — meaning the check **as written
  would STOP a correct implementation and could pass the very bug it exists to
  catch** (0.286 rounds near the stated band's neighborhood). My TC-S1-3 uses
  the corrected band [20, 40]. Plan [SL-4].2 wording should be fixed before S1
  implementation.
- **G2 — PATCH recompute-to-MISS is unpinned.** S3 tests cover recompute-hit
  (test 7) and create-no-rate (test 3), but no pytest pins a PATCH whose
  recompute finds NO rate (occurred_at moved before all history, or currency
  changed to an unrated code) clearing an existing snapshot to NULL/NULL. The
  tempting-wrong implementation (keep the stale snapshot on miss) passes all 16
  current tests. Recommend one pytest arm; TC-S3-3 pins it live regardless.
- **G3 — partial-provider failure during backfill poisons the emptiness
  trigger.** If the empty-table history run has NBRB fail while frankfurter
  succeeds (per-provider isolation, D3), the table becomes non-empty with only
  EUR→USD → the D4 emptiness trigger never re-arms → the five NBRB pairs get
  daily rates but **no history, permanently and silently**. Plan tests 6
  (isolation) and 7 (trigger) each pass while their combination loses data.
  Recommend either a per-provider emptiness check in `fetch_daily_rates` or an
  explicit pytest pinning current behavior + the documented manual re-arm
  (truncate). Design-level — flagging, not silently testing around it.
- **G4 — stale-base snapshot + NO rate arm unpinned.** S3 test 15 proves the
  stale-base fallback when a rate EXISTS; the no-rate variant must land in
  exclude+count (`unconverted_count`), and the tempting-wrong fallback "use the
  stale snapshot when no rate" — which sums a number denominated in a currency
  that is no longer the base — passes all current tests. One fixture row added
  to test 14 or 15 closes it.
- **G5 — single-goal GET consistency unpinned.** The plan argues
  `GET /goals/{id}` must run the assembler over the FULL portfolio ("computing
  it against one goal would lie"), but no S5 test asserts
  `GET /goals/{id}.allocated_monthly_minor` equals the same goal's value in
  `GET /goals` when other goals exist. One equality assertion in test 9's
  fixture closes it; TC-S5-3 pins it live.

## Pushbacks on the plan's QA guidance (numbered — not silently adopted)

- **P1 — live-session shape split S1/S2.** The plan's recommended single session
  ends with "curl GET /fx/convert against a real stored rate", but /fx/convert
  ships in S2 while the fetch infra and the [SL-4] STOP gate belong to S1.
  Resolution: fetch + psql verification + probes at S1 /test (TC-S1-3/4/5);
  the /fx/convert-against-real-rate curl at S2 /test over the persisted rows
  (TC-S2-3), zero extra external HTTP. Still exactly ONE live external session.
- **P2 — degradation requires the warning log.** The plan's split labels
  "provider unreachable (catch-up logs a warning, table stays empty)" as
  degradation. I tighten: the LOG LINE is part of the pass condition — an empty
  table with NO warning is a wiring bug (job never ran / swallowed silently) and
  is a **STOP**, not degradation.
- **P3 — scheduler disabled for S2–S5 servers.** Not in the plan's guidance:
  with `fx_scheduler_enabled` defaulting True, every later /test server boot
  could fire its own catch-up fetch, silently violating the one-live-session
  cap. All S2–S5 /test servers start with `FX_SCHEDULER_ENABLED=false`
  (env-only, no code/.env change).

Everything else in "Test guidance for QA" (mock-at-seam, curl-owned 422/401/
shape split, STOP-rule style, FULL-tier pipeline for S1–S5) — **adopted as
written**.

---

## Preconditions & STOP rules summary

| PC / trigger | Gate | Ruling |
|---|---|---|
| PC-A | dev API on 8010, DB ok | not 200 → STOP (all curl blocked) |
| PC-B | 2 users + tokens + categories | any empty → STOP (S3/S5 blocked) |
| PC-C | providers reachable (S1 only) | unreachable + warning logged → TC-S1-3/4/5b ⏸ degradation, re-run gate before web |
| Wrong numbers | snapshot ≠ /fx/convert; summary delta ≠ hand-pin; band violated (incl. BYN→RUB ≈ 0.2–0.4 = Cur_Scale bug) | **STOP** |
| No-rate path errors | any 404/500 where D7/D8/D9/D-List promise 200-null / exclude+flag | **STOP** |
| frankfurter serves RUB | TC-S1-4 | **STOP — re-groom D1** |
| Boot blocks on fetch | health not 200 while providers hang | **STOP** (D3 violated) |
| Silent no-fetch | empty table AND no catch-up warning in logs | **STOP** (wiring bug, not outage — P2) |
| Contract drift | live /openapi.json ≠ committed | **STOP** |
| Provider outage | warning logged, app healthy, table empty/partial | ⏸ recorded degradation — the D3 design working; re-run when reachable |

Area M (TC-S1-1) is destructive to **budget_test** — no pytest session active.
TC-S1-3's TRUNCATE targets the scope-new `exchange_rates` on live `budget` only.

---

## Final report (filled at each subtask's /test)

Per subtask: Total / Passed / Failed (list) / Blocked (list + reason). Any ❌ →
**FAIL OVERALL**, escalate to senior-lead (I do not fix backend code). All green
→ **READY FOR REVIEW** for that subtask.

- **S1**: TC-S1-1..5 (+ TC-Z1) — ✅ **READY FOR REVIEW** (2026-08-15).
  Total 6 (TC-Z1, TC-S1-1, -2, -3, -4, -5a, -5b counted as one TC) / Passed 6 / Failed 0 /
  Blocked 0. No STOP trigger fired: bands correct (BYN>RUB 27.88, not the 0.2–0.4 Cur_Scale
  bug), frankfurter serves no RUB, boot non-blocking, no silent no-fetch, no inverse rows.
  Live-session budget spent as planned: 1 catch-up backfill round + 3 probe curls + 1 optional
  5b round. **S2–S5 must start their servers with `FX_SCHEDULER_ENABLED=false`** (P3) — the
  live `budget` rows (2282, 2025-07-11..2026-08-15) are now the shared fixture.
  Two mechanics notes carried forward: frankfurter 301→`.dev/v1` (use `curl -sL`; app already
  sets `follow_redirects=True`), and app INFO logs are invisible under uvicorn's default log
  config (WARNINGs still surface — P2 remains enforceable).
- **S2**: TC-S2-1..5 (+ TC-Z1) — ✅ **READY FOR REVIEW** (2026-08-15).
  Total 6 (TC-Z1, TC-S2-1..5) / Passed 6 / Failed 0 / Blocked 0. **No STOP trigger fired:**
  numbers right (8 299 644 recomputes to itself, diff 0), no-rate paths all 200-null (never
  404/500), live openapi deep-equals committed, `from` alias intact end-to-end (wire → openapi →
  schema.d.ts → 422 `loc`).
  **P3 honoured — zero external HTTP:** server ran with `FX_SCHEDULER_ENABLED=false`; log shows
  no frankfurter/nbrb/backfill/catch-up line and 0 WARNING/ERROR. The scope's one live session
  is still the S1 one.
  **Live rates untouched:** `exchange_rates` 2282 rows before == 2282 after, same 6 canonical
  pairs / same min+max dates / 0 non-canonical pairs. No TRUNCATE, no seed, no delete at S2 —
  the shared S1 fixture (incl. the documented BYN>EUR 08-12..08-14 hole) is preserved intact
  for S3–S5.
  Carried forward: the hole is now *positively useful* — TC-S2-3 used it as the live
  nearest-previous probe (08-13 → resolves to the 08-11 row, `rate_as_of` reported as 08-11).
  One cosmetic expectation deviation recorded in TC-S2-4 (identity `rate` is `"1.00000000"`,
  the TC text said `"1"`) — consistent with the contract's 8-dp decimal-string display, not a bug.
- **S3**: TC-S3-1..6 (+ TC-Z1) — ⏸
- **S4**: TC-Z1 only — ⏸
- **S5**: TC-S5-1..6 (+ TC-Z1) — ⏸
