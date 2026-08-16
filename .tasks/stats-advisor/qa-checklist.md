# QA Checklist: stats-advisor (roadmap 4.1 / 4.4 / 4.5 backend; 4.2 web → web-qa; 4.3 mobile FROZEN)

**SCOPE QA STRATEGY, mapped by subtask.** Grooming artifact — nothing is executed
now. Each block runs at the **/test stage of its own subtask** (B1's checks at B1's
/test, etc.).

**Format rule applied per tier** (PM policy 2026-07-27, qa-checklist skill):

| Subtask | Tier | Section B format |
|---|---|---|
| **B1** aggregates | **FULL** | detailed — exact curl, hand-pinned numbers |
| **B2a** plumbing extractions | **STANDARD** | **lightweight** — name / one-line scenario / expected / owner, NO command blocks |
| **B2b** advisor | **FULL** | detailed — exact curl incl. `curl -N` SSE |
| **B3** CSV export | **STANDARD** | **lightweight** |

The 4.2 web screens (plan-web, STANDARD) are **owned by web-qa**, not this file; my
API-level checks underwrite every code and shape the web consumes — in particular
the binding `503 AI_NOT_CONFIGURED` → "AI недоступен — ключ не настроен" mapping.

**Split rule.** pytest (Section A, backend-owned) keeps: period/calendar math, the
three-bucket conversion semantics, DB consistency, user scoping, and **every
Anthropic interaction — mocked at the `app.state.advisor` seam, no live-call gates
(binding)**. My live layer owns what a mocked-seam suite structurally cannot prove:
the real HTTP roundtrip on the wire, the SSE framing as a *client* sees it
(`curl -N`), the rate-limiter's real storage behaviour across requests, Pydantic
422 packs, the 401 walls on two new routers, live-vs-committed OpenAPI, the
cross-request/cross-endpoint consistency invariants, and the byte shape of the
`AI_NOT_CONFIGURED` 503 that the web UI is contractually keyed on. At each /test I
also run the full pytest suite green (TC-Z1) and **do NOT write or fix backend
code** — failures are captured and escalated to senior-lead.

---

## Advisor live-test strategy — MY RULING (senior-lead reviews; receipts R2 / currencies-goals style)

The binding constraint is honest: **pytest never calls Anthropic**, and QA must not
invent a live-call gate. But "no live call" and "no live verification" are different
things. The advisor's live surface splits into three server configurations, and
**the mandatory gates all live in the two that need no real key**:

| Cfg | Server env | What it proves live | TCs | Gating? |
|---|---|---|---|---|
| **CFG-U** *unkeyed* | no `ANTHROPIC_API_KEY` | the binding UI contract's backend half: exact `503 {"detail":"AI_NOT_CONFIGURED"}`, JSON not a stream, 401-before-503, and (Disagreement 1) that the 503 **does not consume advisor quota** | TC-B2b-1, -2, -3 | **YES** |
| **CFG-D** *dummy key* | `ANTHROPIC_API_KEY=qa-dummy-not-a-real-key` | everything up to and including the model call: auth → gate → limiter → **real DB context assembly** → seam → **200 + terminal `event: error` frame**; per-user 429; namespace isolation; history/question caps | TC-B2b-4, -5, -6 | **YES** |
| **CFG-K** *real key* | a real `ANTHROPIC_API_KEY` | the SDK glue nothing else covers: `delta` frames arriving **incrementally**, a terminal `done`, a Russian answer that reflects the seeded aggregates | TC-B2b-8 | **NO — conditional** |

**Reasoning for CFG-D (the load-bearing trick).** With a dummy key the config gate
passes, so the request travels the *entire* real path and the Anthropic call then
fails auth (`401 authentication_error` → `APIError` → `AdvisorError`). The router
must answer **200 with a terminal `event: error` frame** — which is exactly the
D9 protocol arm that a client has to handle, observed through a real HTTP client.
It also makes the limiter countable (the 503 gate is pre-limiter, so an unkeyed
server can never produce a 429 — the 429 checks *require* a key, dummy or real).
**Cost accounting: zero metered tokens** (an auth failure generates no completion —
the receipts S3 precedent, which fired two placeholder-key requests for 0 tokens).
Offline machine → `httpx.ConnectError` → the same `AdvisorError` → the same
200+`error` frame, so TC-B2b-4/5/6 run with no network at all.

**CFG-K is CONDITIONAL and NON-BLOCKING.** If no `ANTHROPIC_API_KEY` is available
at /test, **TC-B2b-8 is recorded 🚫 blocked-non-gating, NOT ❌ failed, and the
scope still passes** — the standing precedent is the PM note of 2026-07-29 on
receipts (live Haiku gate waived; the honest-503 UI requirement replaced it).
Budget if a key exists: **≤ 1 metered Sonnet call per run**, one short question,
`advisor_max_tokens` left at its 2048 default.

**Determinism discipline (carried from currencies-goals, ruling 4).** Every stats
number I assert is hand-computed over rows *I* create in *this* run, converted at
rates *I* seeded by psql. No assertion anywhere depends on live market data. The
one place nondeterminism is allowed is CFG-K's answer text, which is asserted by
*shape* (frames, terminal event, non-empty Russian text), never by content.

---

## Preconditions

### Environment (shared)
```bash
export BASE=http://localhost:8010
export API=/Users/nikitazaretski/work/budget/apps/api
export ROOT=/Users/nikitazaretski/work/budget
# Live server DB (server reads apps/api/.env → 5443/budget):
psql_q() { PGPASSWORD=budget psql -h localhost -p 5443 -U budget -d budget -tAc "$1"; }
# pytest DB (TC-Z1 only — never the live DB):
export TEST_DATABASE_URL=postgresql+asyncpg://budget:budget@localhost:5443/budget_test
```
> **5443 vs 5433 standing rule (1.2–3.x):** committed compose maps `5433`; live app
> + all QA psql target **5443**. Never edit `conftest.py` / `docker-compose.yml` /
> `.env` — env-only setup, per the plan's "Root-file ownership" rule.

### PC-A — dev API up on 8010 — STOP rule
```bash
curl -s -o /dev/null -w '%{http_code}\n' $BASE/health && curl -s $BASE/health   # 200 {"status":"ok","database":"ok"}
```
Started by QA: `cd $API && FX_SCHEDULER_ENABLED=false uv run uvicorn budget_api.app:create_app --factory --port 8010`.
**`FX_SCHEDULER_ENABLED=false` on EVERY server in this scope** (currencies-goals P3:
this scope makes **zero** external FX calls; the live rate table is a fixture, not a
thing to refresh). If the live DB is behind head, `alembic upgrade head` (env setup —
though this scope ships **no migrations**, so a pending migration is itself a
STOP-and-report signal). Not 200 → **STOP**.

### PC-B — two users + tokens + ids + categories
Mirrors 1.3/1.4 PC-3 / currencies-goals PC-B exactly: form-encoded login
(`username` = email), unique per-run emails (`@example.com` — the `.test` TLD is
rejected by registration validation, S5 note), capture `TOKEN_A`, `TOKEN_B`,
`A_ID`, `B_ID`, `RUN`; user A gets one own **expense** category `A_EXP` and one own
**income** category `A_INC`.
```bash
export RUN=$(date +%s); export PW="password123"
export EMAIL_A="qa_sa_a_${RUN}@example.com"; export EMAIL_B="qa_sa_b_${RUN}@example.com"
curl -s -o /dev/null -w 'regA %{http_code}\n' -X POST $BASE/auth/register -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL_A\",\"password\":\"$PW\"}"
curl -s -o /dev/null -w 'regB %{http_code}\n' -X POST $BASE/auth/register -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL_B\",\"password\":\"$PW\"}"
export TOKEN_A=$(curl -s -X POST $BASE/auth/login --data "username=$EMAIL_A&password=$PW" | jq -r '.access_token')
export TOKEN_B=$(curl -s -X POST $BASE/auth/login --data "username=$EMAIL_B&password=$PW" | jq -r '.access_token')
export A_ID=$(curl -s $BASE/users/me -H "Authorization: Bearer $TOKEN_A" | jq -r '.id')
export A_EXP=$(curl -s -X POST $BASE/categories -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' -d '{"name":"qa-exp","kind":"expense"}' | jq -r '.id')
export A_INC=$(curl -s -X POST $BASE/categories -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' -d '{"name":"qa-inc","kind":"income"}' | jq -r '.id')
```
Default profile base is **RUB** (`models/profile.DEFAULT_BASE_CURRENCY`) — assumed
by every hand-pinned number below. STOP if any token/id empty.

### PC-C — deterministic rates: seed one, verify one absent
```bash
psql_q "SELECT count(*) FROM exchange_rates WHERE base='GBP' OR quote='GBP'"   # MUST be 0 (GBP = the no-rate currency)
psql_q "INSERT INTO exchange_rates(base,quote,as_of_date,rate,provider) VALUES ('CHF','RUB','2026-03-01',100.00000000,'nbrb') ON CONFLICT (base,quote,as_of_date) DO UPDATE SET rate=EXCLUDED.rate"
```
`CHF→RUB = 100.00000000` makes every converted figure exact (both exponent 2:
30.00 CHF × 100 = 3000.00 RUB). GBP must have **no** rate on any date — it is the
bucket-3 (exclude-and-flag) driver. **Cleanup at the end of B1's /test:**
`DELETE FROM exchange_rates WHERE base='CHF'` → verify the table is back to the
canonical-6-pairs-only state (the currencies-goals S3 discipline).
If GBP rows exist → pick another unrated 3-letter code and record the substitution.

### PC-D — fixture F (user A only; created once at B1's /test, reused by B2b)
Assumes an **Aug-2026 run**; if the run month differs, shift the "today" row and the
`months=N` windows and recompute (formulae are in each TC). Create AFTER PC-C.

| # | occurred_at | kind | currency | amount_minor | category | merchant |
|---|---|---|---|---|---|---|
| r1 | 2026-01-15 | expense | RUB | 100000 | A_EXP | — |
| r2 | 2026-01-20 | expense | GBP | 5000 | A_EXP | — |
| r3 | 2026-01-22 | expense | GBP | 5000 | A_EXP | — |
| r4 | 2026-02-10 | expense | RUB | 200000 | A_EXP | ALFA |
| r5 | 2026-02-12 | expense | RUB | 50000 | *(null)* | BETA |
| r6 | 2026-02-20 | income | RUB | 700000 | A_INC | SALARYCO |
| r7 | 2026-02-05 | expense | GBP | 5000 | A_EXP | GAMMA |
| r8 | 2026-03-05 | expense | RUB | 300000 | A_EXP | ALFA |
| r9 | 2026-03-12 | expense | CHF | 3000 | A_EXP | ALFA |
| r10 | *today* | expense | RUB | 10000 | A_EXP | — |

r9 must be created **after** PC-C's seed so its snapshot auto-computes to
`300000 / RUB` (bucket 2). r2/r3/r7 are GBP with no rate → snapshot `null/null` at
create, excluded-and-counted at read (bucket 3). Verify once:
`psql_q "SELECT currency, base_amount_minor FROM transactions WHERE user_id='$A_ID' ORDER BY occurred_at"`
→ r9 shows `CHF | 300000`; r2/r3/r7 show `GBP | NULL`. If not → **STOP** (the
fixture is wrong and every pin below is meaningless).
**Never create fixture rows on user A outside this table** — the D14 boundary
checks (which create a `MAX_MINOR_AMOUNT` row) run as **user B** for exactly this
reason.

### PC-E — advisor key availability (B2b only)
```bash
[ -n "$ANTHROPIC_API_KEY" ] && echo "key present" || echo "NO KEY"
```
Absent → **TC-B2b-8 is 🚫 blocked-non-gating** (not failed); CFG-U and CFG-D checks
all still run and are the gate. Present → senior-lead/PM confirms the **≤1 metered
Sonnet call** budget (Q2 below) before I run TC-B2b-8.

---

# Section A — pytest test cases (owned by backend-engineer)

**I do not restate the plan's lists.** They are numbered in `plan.md` and are the
contract for Section A:

| Subtask | pytest cases | Files |
|---|---|---|
| **B1** | plan **B1-1..17** (periods 1–3; stats endpoints 4–15; D14 bounds 16–17) | `tests/test_periods.py`, `tests/test_stats.py`, `tests/test_transactions.py`, `tests/test_goals_api.py` |
| **B2a** | **none added, by design** — `tests/test_receipts.py` (incl. `test_parse_ai_not_configured`, the two per-user RL tests) and all of `tests/test_goals_api.py` are the guard, **unmodified** (O-4) | — |
| **B2b** | plan **B2b-1..11** (stream/done, error-on-200 both positions, 503, 503-no-quota, per-user 429, namespace isolation, history caps, no-raw-transactions, window, auth-before-gate, exponent) | `tests/test_advisor.py` |
| **B3** | plan **B3-1..5** (columns/major units, BOM+RFC4180, ASC order, filters, scope+auth) | `tests/test_transactions.py::TestExport` |

**Cross-check verdict: the lists are strong** — every one carries an explicit
contrast arm, and the two `[assumption]`s that would otherwise live in comments
(expense-only merchants, current-partial-month exclusion) are pinned by B1-12 and
B2b-9. Adopted as written **except** the numbered gaps below. Section A passes when
`TC-Z1` (full suite) is green; per-case status is the backend's report, not mine.

## GAPS found in the plan's pytest lists (numbered — senior-lead rules; I do not rewrite plan.md)

- **GAP-1 — `previous.unconverted_count` is vacuous as specified (B1-9).** B1-9 puts
  *one* no-rate row in the current period and claims to pin
  `previous.unconverted_count` — which will be `0`. A hardcoded `0`, or a copy of
  the current period's value, or a `previous` block computed over the *current*
  window, all pass. **Proposed fix:** the fixture gets a *different* number of
  no-rate rows in the previous period (e.g. current 1 / previous 2) so the two
  numbers must differ. Pinned live regardless by TC-B1-3.
- **GAP-2 — no pytest arm asserts a NEGATIVE `net_minor`.** `net = income −
  expense` is signed by decision, and D15/F4(b) explicitly obliges the charts to
  tolerate negative months — yet every B1 fixture arm as written can be satisfied
  by `abs()` or `max(0, …)`. **Proposed fix:** one expense-only month in B1-4 or
  B1-10 asserting `net_minor < 0` exactly. Pinned live by TC-B1-3/-4.
- **GAP-3 — behaviour of a *redundant* anchor is unspecified (D5 / B1-7).** B1-7
  covers missing and *mismatched* anchors, but not
  `?period=month&month=2026-02&quarter=2026-Q1` (correct anchor **plus** a stray
  one). D5 says "missing/mismatched → 422" and is silent here. This is a spec
  question, not a test bug: **senior-lead must pick** (recommendation: **ignore
  extra anchors**, since a client switching tabs will naturally leave stale query
  params behind, and 422-ing a request whose intent is unambiguous is hostile), then
  one pytest arm pins whichever way. I will observe and record the shipped
  behaviour in TC-B1-2 without failing on it until the ruling lands.
- **GAP-4 — nothing asserts the client-carried history actually REACHES the seam
  (B2b).** OQ-2's entire premise is chat memory carried by the client. B2b-7 pins
  the caps and B2b-8 reads `fake.last_context`, but no case asserts
  `fake.last_history` equals the posted turns in order with roles intact. A router
  that silently drops `payload.history` passes all 11 cases while the chat feature
  is dead. **Proposed fix:** one assertion on the accept arm of B2b-7.
- **GAP-5 — the `question` validator's own arms are unpinned (B2b).** `strip` +
  blank-rejection + `max 2000` is *custom* validation (blank-after-strip is not a
  plain Pydantic constraint), and no B2b case exercises it. **Proposed fix:** fold
  `""`, `"   "`, 2001 chars and the 2000-char accept arm into B2b-7. I cover it live
  in TC-B2b-6 either way.
- **GAP-6 — the CSV response HEADERS are unpinned (B3).** B3-1..5 assert bytes,
  order, filters and scope, but nothing asserts
  `content-type: text/csv; charset=utf-8` or
  `Content-Disposition: attachment; filename="transactions.csv"` — which *are* the
  download affordance (without them a browser renders the CSV inline and D13's
  `createObjectURL` handoff is the only thing standing between the user and a wall
  of text). **Proposed fix:** two header assertions in B3-2. Covered live by CT-B3-1.
- **GAP-7 — the advisor context's `unconverted_count` is never asserted non-zero
  (B2b).** It is a designed field ("exclude-and-flag honesty, carried into the
  prompt"); a router hardcoding `0` passes every case. **Proposed fix:** the B2b-8
  fixture already seeds transactions — add one no-rate foreign row and assert both
  `last_context.unconverted_count == 1` and that `render_prompt` mentions it.

**Sequencing note (not a gap):** the plan's intro says "B3 is otherwise independent
and may be resequenced ahead of B2", but B3's header declares **Depends on: B2b**
for `domain/money.to_major_string`. Both cannot be true. If B3 is resequenced,
`to_major_string` moves to B3 — worth one word in the plan so the engineer does not
discover it mid-run.

---

# Section B — curl test cases (owned by qa-engineer)

## TC-Z1 — full pytest suite green (runs FIRST at EVERY subtask's /test)
```bash
cd $API && TEST_DATABASE_URL=postgresql+asyncpg://budget:budget@localhost:5443/budget_test uv run pytest
```
Confirms Section A. Run **before** any server start (no competition for the test DB).
Any failure → capture, **do not fix backend code**, escalate to senior-lead.
- **Status**: ✅ B1 run 2026-08-16 — 226 passed, 0 failed (36.9s, budget_test @5443)

---

# TC-B1 — aggregates (tier **FULL** — detailed format)

*pytest owns (B1-1..17): calendar math, window semantics, bucket algebra, ordering,
user scoping, the D14 boundaries. My live layer owns: the 401 wall on the new
router, the period-grammar 422/edge pack on the wire, hand-pinned numbers over real
rows and a seeded rate, the per-point flag resolution as a client sees it, the
cross-endpoint consistency invariant `/stats/summary` ≡ `/transactions/summary`
(same month ⇒ same numbers — the one thing that catches a second aggregation
implementation), the D14 bounds as wire 422s, and live-vs-committed contract.*

### TC-B1-1: 401 wall on /stats (once per new router + one nested spot)
- **Method/Endpoint**: GET `/stats/summary`, `/stats/monthly`, `/stats/top-merchants`
- **Auth**: none
- **Expected**: all three **401** `{"detail":"Unauthorized"}`; the wall fires
  **before** validation (a request with a deliberately invalid `period` still 401s,
  never 422 — otherwise the router leaks its grammar to anonymous callers).
- **curl**:
```bash
for P in "summary?period=month&month=2026-02" "monthly?months=3" "top-merchants?period=year&year=2026"; do
  curl -s -o /dev/null -w "$P %{http_code}\n" "$BASE/stats/$P"; done      # 401 ×3
curl -s -o /dev/null -w 'badperiod-noauth %{http_code}\n' "$BASE/stats/summary?period=nonsense"   # 401, NOT 422
```
- **Status**: ✅ pass — 401 {"detail":"Unauthorized"} on all three routes + on `?period=nonsense` (no grammar leak) and on a garbage bearer

### TC-B1-2: period grammar — four units happy, `PERIOD_ANCHOR_REQUIRED` 422 pack, `from>to` empty-200, bounds
- **Setup**: PC-D fixture F.
- **Expected**:
  - `period=month&month=2026-02` → **200**, `period == {"from":"2026-02-01","to":"2026-02-28"}` (inclusive echo; 2026 is not a leap year).
  - `period=quarter&quarter=2026-Q1` → 200, `period 2026-01-01..2026-03-31`.
  - `period=year&year=2026` → 200, `period 2026-01-01..2026-12-31`.
  - `period=custom&from=2026-02-01&to=2026-02-10` → 200, echo verbatim.
  - **422 `{"detail":"PERIOD_ANCHOR_REQUIRED"}`** (business code, not
    `HTTPValidationError`) for: `period=month` alone; `period=custom&from=…` only;
    `period=quarter&year=2026` (mismatched); `period=year` alone.
  - **Auto-`HTTPValidationError` 422** (`detail[].loc`) for: missing `period`
    entirely; `period=weekly`; `month=2026-13`; `quarter=2026-Q5`; `year=1969`.
  - `period=custom&from=2026-03-01&to=2026-02-01` (from > to) → **200** with all
    zeros and `by_category: []` — never 4xx (decision-l).
  - `months=0` / `months=61` → 422; `months=60` → 200 with 60 points.
    `limit=0` / `limit=51` → 422; `limit=50` → 200.
  - **GAP-3 observation (recorded, not gated):** `period=month&month=2026-02&quarter=2026-Q1`
    → record whether it is 200 (extras ignored) or 422.
  - **Regression arm (B1 moves `_MONTH_PATTERN` out of `routers/transactions.py`):**
    `/transactions/summary?month=2026-02` still 200, and `?month=2026-13` still 422.
- **curl**:
```bash
H="Authorization: Bearer $TOKEN_A"
for Q in "period=month&month=2026-02" "period=quarter&quarter=2026-Q1" "period=year&year=2026" "period=custom&from=2026-02-01&to=2026-02-10"; do
  curl -s -H "$H" "$BASE/stats/summary?$Q" | jq -c '{q:"'"$Q"'", period}'; done
for Q in "period=month" "period=custom&from=2026-02-01" "period=quarter&year=2026" "period=year"; do
  echo -n "$Q -> "; curl -s -w ' [%{http_code}]\n' -H "$H" "$BASE/stats/summary?$Q"; done   # {"detail":"PERIOD_ANCHOR_REQUIRED"} [422]
for Q in "" "period=weekly" "period=month&month=2026-13" "period=quarter&quarter=2026-Q5" "period=year&year=1969"; do
  curl -s -o /dev/null -w "auto422 '$Q' %{http_code}\n" -H "$H" "$BASE/stats/summary?$Q"; done   # 422 ×5
curl -s -H "$H" "$BASE/stats/summary?period=custom&from=2026-03-01&to=2026-02-01" | jq -c '{income_minor,expense_minor,net_minor,unconverted_count,by_category}'   # all 0 / []
curl -s -o /dev/null -w 'months0 %{http_code}\n'   -H "$H" "$BASE/stats/monthly?months=0"
curl -s -o /dev/null -w 'months61 %{http_code}\n'  -H "$H" "$BASE/stats/monthly?months=61"
curl -s -H "$H" "$BASE/stats/monthly?months=60" | jq '.points | length'                    # 60
curl -s -o /dev/null -w 'limit0 %{http_code}\n'    -H "$H" "$BASE/stats/top-merchants?period=year&year=2026&limit=0"
curl -s -o /dev/null -w 'limit51 %{http_code}\n'   -H "$H" "$BASE/stats/top-merchants?period=year&year=2026&limit=51"
curl -s -o /dev/null -w 'redundant-anchor %{http_code}\n' -H "$H" "$BASE/stats/summary?period=month&month=2026-02&quarter=2026-Q1"   # GAP-3: record
curl -s -o /dev/null -w 'txsummary-ok %{http_code}\n'  -H "$H" "$BASE/transactions/summary?month=2026-02"
curl -s -o /dev/null -w 'txsummary-422 %{http_code}\n" ' -H "$H" "$BASE/transactions/summary?month=2026-13"
```
- **Status**: ✅ pass — 4 happy echoes exact; PERIOD_ANCHOR_REQUIRED ×4; auto-422 ×5; from>to → 200 all-zeros/`by_category []`; months 0/61→422, 60→60 pts; limit 0/51→422, 50→200; year-envelope probes (month 9999-12, quarter 9999-Q4, custom to=9999-12-31, custom from=0001-01-01) all 422 HTTPValidationError, no 500; /transactions/summary 2026-02→200, 2026-13→422, 9999-12→422; GAP-3/AM-3: redundant anchor → 200, body byte-identical to plain month request

### TC-B1-3: hand-pinned totals + prev-period correctness + the flag, over fixture F
- **Depends on**: PC-C, PC-D.
- **Expected** (every number hand-computed; a mismatch is a **STOP**):

  **(a) `period=month&month=2026-02`**
  ```
  income_minor 700000 · expense_minor 250000 · net_minor 450000 · unconverted_count 1
  by_category (order is load-bearing: kind ASC, then total DESC)
    [ {A_EXP, expense, 200000}, {null, expense, 50000}, {A_INC, income, 700000} ]
  previous  {from 2026-01-01, to 2026-01-31, income 0, expense 100000,
             net -100000, unconverted_count 2}
  ```
  → `net_minor` of `previous` is **negative** (GAP-2 live pin) and
  `unconverted_count` differs between the two blocks, **1 vs 2** (GAP-1 live pin:
  a copied or hardcoded value cannot survive this).

  **(b) `period=quarter&quarter=2026-Q1`**
  ```
  income 700000 · expense 950000 (100000 + 250000 + 300000 + 300000[r9 CHF converted])
  net -250000 · unconverted_count 3
  previous {from 2025-10-01, to 2025-12-31, all zeros}
  ```
  → r9's `300000` proves the seeded CHF→RUB=100 conversion landed exactly
  (30.00 CHF × 100 = 3000.00 RUB); the three GBP rows are excluded and counted.

  **(c) `period=year&year=2026`**: expense `960000` (adds r10), income `700000`,
  net `-260000`, unconverted `3`; `previous` = 2025, all zeros.

  **(d) custom prev is same-length, NOT calendar** —
  `period=custom&from=2026-02-01&to=2026-02-10`:
  ```
  current  expense 200000 (r4 dated exactly `to` IS included — inclusive-end pin)
           income 0 · unconverted_count 1 (r7)
  previous {from 2026-01-22, to 2026-01-31}  →  expense 0, unconverted_count 1 (r3 only)
  ```
  A calendar-month `previous` would return `expense 100000 / unconverted 2` — the
  two are structurally distinguishable, which is the point.

  **(e) cross-endpoint consistency (the second-implementation trap):**
  `/stats/summary?period=month&month=2026-02` and
  `/transactions/summary?month=2026-02` must agree **exactly** on
  `currency`, `income_minor`, `expense_minor`, `net_minor`, `unconverted_count`
  and `by_category` (both ride `converted_totals` — a divergence means two
  aggregation paths, D1's whole premise broken → **STOP**).
- **curl**:
```bash
H="Authorization: Bearer $TOKEN_A"
curl -s -H "$H" "$BASE/stats/summary?period=month&month=2026-02"   | jq -c '{period,income_minor,expense_minor,net_minor,unconverted_count,by_category,previous}'
curl -s -H "$H" "$BASE/stats/summary?period=quarter&quarter=2026-Q1" | jq -c '{income_minor,expense_minor,net_minor,unconverted_count,previous}'
curl -s -H "$H" "$BASE/stats/summary?period=year&year=2026"        | jq -c '{period,income_minor,expense_minor,net_minor,unconverted_count,previous}'
curl -s -H "$H" "$BASE/stats/summary?period=custom&from=2026-02-01&to=2026-02-10" | jq -c '{period,income_minor,expense_minor,unconverted_count,previous}'
S=$(curl -s -H "$H" "$BASE/stats/summary?period=month&month=2026-02")
T=$(curl -s -H "$H" "$BASE/transactions/summary?month=2026-02")
python3 - "$S" "$T" <<'EOF'
import sys, json
s, t = json.loads(sys.argv[1]), json.loads(sys.argv[2])
k = ("currency","income_minor","expense_minor","net_minor","unconverted_count","by_category")
print({"consistent": all(s[f] == t[f] for f in k)})   # True
EOF
```
- **Status**: ✅ pass — (a) 700000/250000/450000/unc 1, by_category order [A_EXP 200000, null 50000, A_INC 700000], previous 2026-01-01..01-31 0/100000/-100000/unc 2 (GAP-1 1≠2, GAP-2 negative net); (b) 700000/950000/-250000/unc 3 (CHF r9 = 300000 exactly), previous 2025-Q4 zeros; (c) 700000/960000/-260000/unc 3, previous 2025 zeros; (d) custom prev = 2026-01-22..01-31, expense 0/unc 1 (same-length, not calendar); (e) /stats/summary ≡ /transactions/summary on all 6 keys

### TC-B1-4: monthly — dense ascending series, current month included, PER-POINT flags
- **Depends on**: PC-D. Aug-2026 run assumed; for month M, `months=8` spans
  `M-7 … M` inclusive.
- **Expected** (`GET /stats/monthly?months=8`): exactly **8** points, `month` keys
  ascending `2026-01 … 2026-08`, `currency == "RUB"`:
  ```
  2026-01 {0, 100000, -100000, unconverted 2}
  2026-02 {700000, 250000, 450000, unconverted 1}
  2026-03 {0, 600000, -600000, unconverted 0}
  2026-04 · 2026-05 · 2026-06 · 2026-07  → all zeros, PRESENT (dense)
  2026-08 {0, 10000, -10000, unconverted 0}      ← r10 dated TODAY: current month included
  ```
  The flag distribution `2 / 1 / 0 …` is the D4 per-point honesty pin: a top-level
  or broadcast count cannot produce three different values. `months=3` → exactly
  `[2026-06 zeros, 2026-07 zeros, 2026-08 …]`; a row one month before the window
  (2026-05 has none — verified by the zeros) never leaks in.
- **curl**:
```bash
H="Authorization: Bearer $TOKEN_A"
curl -s -H "$H" "$BASE/stats/monthly?months=8" | jq -c '{currency, n:(.points|length), points:[.points[]|{month,income_minor,expense_minor,net_minor,unconverted_count}]}'
curl -s -H "$H" "$BASE/stats/monthly?months=3" | jq -c '[.points[].month]'   # ["2026-06","2026-07","2026-08"]
```
- **Status**: ✅ pass — months=8 → 8 dense ascending points 2026-01..2026-08, currency RUB, flags 2/1/0/0/0/0/0/0, 2026-08 = {0,10000,-10000} (today's row included); months=3 → [2026-06,2026-07,2026-08]

### TC-B1-5: top-merchants — order, limit-after-fold-in, expense-only, null-merchant, unconverted omission
- **Depends on**: PC-D.
- **Expected** (`?period=quarter&quarter=2026-Q1`, default `limit=10`):
  ```
  items [ {ALFA, 800000, 3}, {BETA, 50000, 1} ]      # ALFA = r4 200000 + r8 300000 + r9 300000
  unconverted_count 1                                 # r7 (GAMMA, GBP, no rate)
  period 2026-01-01..2026-03-31 · currency RUB
  ```
  - **GAMMA is absent from `items` entirely** — its only row is unconverted; a
    `{GAMMA, 0, 1}` row would read "spent nothing here", which is a lie (the plan's
    pinned gap-fill decision, B1-13).
  - **SALARYCO (income 700000, larger than every expense) is absent** — expense-only
    (B1-12 / obligation O-3) observed on the wire.
  - r1/r2/r3/r10 have no merchant → out of the population; no `null` / `""` entry
    appears anywhere.
  - `limit=1` → exactly `[ALFA]`, and `unconverted_count` stays **1** (the flag
    describes the *window*, not the truncated list).
- **curl**:
```bash
H="Authorization: Bearer $TOKEN_A"
curl -s -H "$H" "$BASE/stats/top-merchants?period=quarter&quarter=2026-Q1" | jq -c '{period,currency,items,unconverted_count}'
curl -s -H "$H" "$BASE/stats/top-merchants?period=quarter&quarter=2026-Q1&limit=1" | jq -c '{items,unconverted_count}'
curl -s -H "$H" "$BASE/stats/top-merchants?period=quarter&quarter=2026-Q1" | jq '[.items[].merchant] | index("SALARYCO"), index("GAMMA")'   # null, null
```
- **Status**: ✅ pass — items [{ALFA,800000,3},{BETA,50000,1}], unconverted_count 1; GAMMA and SALARYCO absent; no null/empty merchant; limit=1 → [ALFA] with unconverted_count still 1

### TC-B1-6: D14 upper bounds on the wire — MAX+1 → 422, MAX → 201 (**user B only**)
- **Auth**: `TOKEN_B` — a `MAX_MINOR_AMOUNT` row must never touch user A's pinned
  fixture. Also doubles as a live user-scoping check.
- **Expected** with `MAX = 999999999999999`:
  - POST `/transactions` `amount_minor = MAX+1` → **422**; `= MAX` → **201**
    (the accept arm, without which the rejection would pass against a bound of 1).
  - `base_amount_minor = MAX+1` (with `currency:"USD"`) → 422.
  - POST `/goals` `target_minor = MAX+1` → 422; `= MAX` → 201.
    `initial_saved_minor = MAX+1` → 422.
  - POST contributions `amount_minor = MAX+1` → 422 **and `= -(MAX+1)` → 422**
    (both signs — a bare `le=` leaves `-1e18` legal); `= -MAX` → 201.
  - All rejections are `HTTPValidationError`-shaped (`detail[].type ==
    "less_than_equal"` / `"greater_than_equal"`), never 500.
  - **Scoping arm**: after creating B's `MAX` rows, re-run TC-B1-3(c) as user A →
    **byte-identical** response. B's absurd rows must not appear in, or overflow,
    A's aggregates.
- **curl**:
```bash
HB="Authorization: Bearer $TOKEN_B"; CT='Content-Type: application/json'; MAX=999999999999999
curl -s -o /dev/null -w 'tx max+1 %{http_code}\n' -X POST $BASE/transactions -H "$HB" -H "$CT" -d "{\"amount_minor\":$((MAX+1)),\"kind\":\"expense\",\"occurred_at\":\"2026-02-10\"}"   # 422
curl -s -o /dev/null -w 'tx max   %{http_code}\n' -X POST $BASE/transactions -H "$HB" -H "$CT" -d "{\"amount_minor\":$MAX,\"kind\":\"expense\",\"occurred_at\":\"2026-02-10\"}"        # 201
curl -s -o /dev/null -w 'tx base max+1 %{http_code}\n' -X POST $BASE/transactions -H "$HB" -H "$CT" -d "{\"amount_minor\":100,\"kind\":\"expense\",\"occurred_at\":\"2026-02-10\",\"currency\":\"USD\",\"base_amount_minor\":$((MAX+1))}"   # 422
curl -s -o /dev/null -w 'goal max+1 %{http_code}\n' -X POST $BASE/goals -H "$HB" -H "$CT" -d "{\"name\":\"qa\",\"target_minor\":$((MAX+1)),\"currency\":\"RUB\"}"   # 422
GID=$(curl -s -X POST $BASE/goals -H "$HB" -H "$CT" -d "{\"name\":\"qa-max\",\"target_minor\":$MAX,\"currency\":\"RUB\"}" | jq -r '.id')   # 201
for A in $((MAX+1)) -$((MAX+1)) -$MAX; do
  curl -s -o /dev/null -w "contrib $A %{http_code}\n" -X POST $BASE/goals/$GID/contributions -H "$HB" -H "$CT" -d "{\"amount_minor\":$A,\"occurred_at\":\"2026-02-10\"}"; done   # 422 422 201
curl -s -H "Authorization: Bearer $TOKEN_A" "$BASE/stats/summary?period=year&year=2026" | jq -c '{income_minor,expense_minor,net_minor,unconverted_count}'   # unchanged from TC-B1-3(c)
```
- **Cleanup**: delete user B's run-scoped rows (or the user, cascade) at the end of B1's /test.
- **Status**: ✅ pass — tx MAX+1 422 (`less_than_equal`) / MAX 201; base_amount_minor MAX+1 422; goal target & initial_saved MAX+1 422, target MAX 201; contribution MAX+1 422 (`less_than_equal`), -(MAX+1) 422 (`greater_than_equal`), -MAX 201 (see deviation note: needs a funded goal — the first -MAX attempt hit the pre-existing business rule CONTRIBUTION_EXCEEDS_SAVED at saved=100); scoping arm: A's year-2026 response byte-identical before/after B's MAX rows

### TC-B1-7: contract — live == committed; the honest 422 arms; `from` alias survives; D14 bounds visible
- **Expected**:
  - live `GET /openapi.json` **deep-equals** committed `apps/api/openapi.json`
    (whole document, python3 compare) — anything else is contract drift → **STOP**.
  - `/stats/summary` and `/stats/top-merchants` 422 = the **anyOf union
    `StatsError | HTTPValidationError`** (the standing AM-5 pattern, TC-24 style).
  - `/stats/monthly` 422 = **`HTTPValidationError` ONLY, no `StatsError` arm** —
    the endpoint has no business 422, and declaring an arm it cannot emit is the
    exact inverted-AM-5 lie the plan's Disagreement 3 rejects.
  - `StatsError`, `StatsSummaryRead`, `MonthlyRead`, `TopMerchantsRead`,
    `PeriodBounds`, `PeriodTotals` components present; `by_category` reuses the
    existing `CategorySummary` component (one TS type shared with
    `/transactions/summary` — not a forked copy).
  - `PeriodBounds` / `PeriodTotals` expose the literal key **`from`** (un-mangled,
    the `FxConvertRead` precedent), and `schema.d.ts` renders
    `period: { from: string; to: string }` — the [SL-1] regen line.
  - `TransactionCreate.amount_minor` / `.base_amount_minor`, `GoalCreate.target_minor`
    / `.initial_saved_minor`, `ContributionCreate.amount_minor` carry
    `maximum: 999999999999999` (and the contribution also `minimum: -999999999999999`).
- **curl**:
```bash
curl -s $BASE/openapi.json > /tmp/live_openapi.json
python3 -c "import json;a=json.load(open('/tmp/live_openapi.json'));b=json.load(open('$API/openapi.json'));print('identical', a==b)"
jq -c '.paths["/stats/summary"].get.responses["422"].content["application/json"].schema' /tmp/live_openapi.json      # anyOf [StatsError, HTTPValidationError]
jq -c '.paths["/stats/monthly"].get.responses["422"].content["application/json"].schema' /tmp/live_openapi.json      # $ref HTTPValidationError only
jq -c '.paths["/stats/summary"].get.responses | keys' /tmp/live_openapi.json
jq -c '.components.schemas.PeriodBounds.properties | keys' /tmp/live_openapi.json                                    # ["from","to"]
jq -c '.components.schemas.TransactionCreate.properties.amount_minor' /tmp/live_openapi.json                         # maximum 999999999999999
jq -c '.components.schemas.ContributionCreate.properties.amount_minor' /tmp/live_openapi.json                        # minimum -MAX, maximum MAX
grep -n "period: {" -A 3 $ROOT/packages/api-client/src/generated/schema.d.ts | head
cd $ROOT && git status --porcelain apps/api/openapi.json packages/api-client/src/generated/schema.d.ts               # empty = regen was committed with the code
```
- **Status**: ✅ pass — live /openapi.json deep-equals working-tree apps/api/openapi.json (python3 `a==b` True); summary & top-merchants 422 = anyOf[StatsError,HTTPValidationError], monthly 422 = $ref HTTPValidationError only; responses keys ["200","401","422"] ×3 with 401 → $ref StatsError (accepted deviation); StatsError/StatsSummaryRead/MonthlyRead/MonthlyPoint/TopMerchantsRead/MerchantTotalRead/PeriodBounds/PeriodTotals present; by_category → shared CategorySummary (same component as SummaryRead); PeriodBounds/PeriodTotals expose literal `from`; schema.d.ts renders `PeriodBounds: { from: string; to: string }`; D14 maxima 999999999999999 (contribution also minimum -999999999999999). Artifacts intentionally uncommitted this run (ruling 4) — pair regenerated together.

---

# CT-B2a — plumbing extractions (tier **STANDARD** — lightweight format, no command blocks)

*Three signature-preserving extractions (`ai_gate`, `user_rl_key`, `goal_reads`)
whose acceptance gate is "nothing changed". The executing QA composes commands at
run time. `pnpm openapi` producing an empty diff (O-5) is the headline check.*

| # | Scenario (one line) | Expected | Owner |
|---|---|---|---|
| CT-B2a-1 | Full suite after the extractions, with `tests/test_receipts.py` and `tests/test_goals_api.py` **unmodified** (`git diff --stat` on those two files is empty) | TC-Z1 green, same count as before + 0 new; both guard files untouched (O-4) | live (QA) |
| CT-B2a-2 | `pnpm openapi` from the repo root, then `git status --porcelain` on `apps/api/openapi.json` + `packages/api-client/src/generated/schema.d.ts` | **Empty output** — zero contract diff (O-5, the subtask's acceptance gate) | live (QA) |
| CT-B2a-3 | Receipts 503 byte shape after the `ai_gate` extraction: authenticated parse call on an **unkeyed** server (CFG-U), against any receipt id | **503** `{"detail":"AI_NOT_CONFIGURED"}`, `content-type: application/json` — byte-identical to pre-scope behaviour, incl. **503 before the 404 lookup** | live (QA) |
| CT-B2a-4 | Same parse call with **no token** on the unkeyed server | **401**, not 503 — auth still wins over the gate (the ordering half of O-4; the plan's inline-call-site argument is exactly what this verifies) | live (QA) |
| CT-B2a-5 | Receipts per-user rate limit still enforced after `receipt_rl_key = user_rl_key("receipt")`: tight `RECEIPT_CREATE_RATE_LIMIT` on a restart, two creates as A then one as B | A's 2nd → 429 `{"detail":"RATE_LIMITED"}`, B's 1st → 201 (per-user key survived the factory generalization) | live (QA) |
| CT-B2a-6 | Goals portfolio after the assembler move: `GET /goals` and `GET /goals/{id}` for a goal created in this run | 200 with the computed fields present and mutually consistent — smoke that the move did not break the shipped screen | live (QA) |

- **Status**: all ⏸ pending
- **STOP for B2a**: any non-empty contract diff, any change in the receipts 503
  bytes/ordering, or any modification to the two guard test files.

---

# TC-B2b — AI advisor (tier **FULL** — detailed format)

*pytest owns (B2b-1..11): the seam-mocked stream/error framing, the caps, the
no-raw-transactions §security pin, the window, the exponent rendering. My live
layer owns what the ASGI-transport suite cannot: the 503's exact bytes as the web
UI will receive them, the SSE frames as `curl` (a real HTTP client) parses them,
the limiter's real cross-request storage behaviour with real namespaces, and
contract honesty on a non-JSON 200. **See the ruling above for CFG-U / CFG-D /
CFG-K.** Server always `FX_SCHEDULER_ENABLED=false`.*

### TC-B2b-1: the honest unkeyed 503 — the binding UI contract's backend half (CFG-U)
- **Server**: `cd $API && FX_SCHEDULER_ENABLED=false uv run uvicorn budget_api.app:create_app --factory --port 8010`
  (no `ANTHROPIC_API_KEY` in the environment; verify `apps/api/.env` has none).
- **Expected**: **503**; body **exactly** `{"detail":"AI_NOT_CONFIGURED"}` (byte
  compare, no extra keys, no trailing content); `content-type: application/json`
  — **NOT** `text/event-stream`; **no SSE frames at all** (a stream that opens and
  then emits an error frame would break the web's `if (res.status === 503)` mapping);
  the response is complete and closed, not chunked.
  Byte-identical to the receipts 503 on the same server (D11: one pattern, not two).
- **curl**:
```bash
H="Authorization: Bearer $TOKEN_A"; CT='Content-Type: application/json'
curl -s -i -X POST $BASE/advisor/ask -H "$H" -H "$CT" -H 'Accept: text/event-stream' \
  -d '{"question":"Как мне сократить расходы?"}'
# expect: HTTP/1.1 503 ... content-type: application/json ... {"detail":"AI_NOT_CONFIGURED"}
A=$(curl -s -X POST $BASE/advisor/ask -H "$H" -H "$CT" -d '{"question":"тест"}')
R=$(curl -s -X POST $BASE/receipts/00000000-0000-0000-0000-000000000000/parse -H "$H")
[ "$A" = "$R" ] && echo "503 bytes identical across advisor and receipts"
```
- **STOP**: any other status, any other body bytes, or a `text/event-stream`
  content-type (the UI contract is keyed on this exact shape).
- **Status**: ⏸ pending

### TC-B2b-2: auth wins over the gate — no token + no key → 401 (CFG-U)
- **What**: the parameter-order landmine in the handler signature (`stash_rl_user`
  before `require_ai_configured`). A reordering regression is otherwise invisible:
  the endpoint would tell anonymous callers about the server's key configuration.
- **Expected**: **401** `{"detail":"Unauthorized"}`, not 503. Same for a garbage
  bearer token.
- **curl**:
```bash
curl -s -w ' [%{http_code}]\n' -X POST $BASE/advisor/ask -H 'Content-Type: application/json' -d '{"question":"тест"}'                  # 401
curl -s -w ' [%{http_code}]\n' -X POST $BASE/advisor/ask -H 'Authorization: Bearer not.a.token' -H 'Content-Type: application/json' -d '{"question":"тест"}'   # 401
```
- **STOP**: a 503 here (information disclosure + broken ordering).
- **Status**: ⏸ pending

### TC-B2b-3: the 503 does NOT consume advisor quota (CFG-U + a tight limit) — Disagreement 1 live
- **Server**: restart CFG-U with `RATE_LIMIT_ENABLED=true ADVISOR_ASK_RATE_LIMIT=1/minute`.
- **What**: the binding UI requirement — the "Спросить AI" button must keep saying
  "ключ не настроен" on the second click, not "RATE_LIMITED".
- **Expected**: **three consecutive** asks → **503, 503, 503**; never a 429.
- **Contrast arm (without which this TC is vacuous — a *disabled* limiter also
  yields 503×3):** restart on **CFG-D** with the same `1/minute` and repeat →
  the 2nd ask **must** be 429. Only that pair proves the limiter was armed and the
  gate genuinely runs before it.
- **curl**:
```bash
H="Authorization: Bearer $TOKEN_A"; CT='Content-Type: application/json'
for i in 1 2 3; do curl -s -o /dev/null -w "unkeyed#$i %{http_code}\n" -X POST $BASE/advisor/ask -H "$H" -H "$CT" -d '{"question":"тест"}'; done   # 503 503 503
# --- restart on CFG-D (ANTHROPIC_API_KEY=qa-dummy-not-a-real-key), same 1/minute ---
for i in 1 2; do curl -s -o /dev/null -w "dummy#$i %{http_code}\n" -X POST $BASE/advisor/ask -H "$H" -H "$CT" -d '{"question":"тест"}'; done      # 200 then 429
```
- **STOP**: a 429 on the unkeyed server (quota consumed → the UI contract breaks).
- **Status**: ⏸ pending

### TC-B2b-4: SSE stream shape through a real HTTP client (CFG-D) — 200 + terminal `event: error`
- **Server**: `cd $API && FX_SCHEDULER_ENABLED=false RATE_LIMIT_ENABLED=false
  ANTHROPIC_API_KEY=qa-dummy-not-a-real-key uv run uvicorn budget_api.app:create_app --factory --port 8010`
- **What**: the whole real path — auth → gate → limiter → **live DB context
  assembly over fixture F** (aggregates + goals + category names + profile) → seam
  → error framing. This is the D9 arm every client must handle, and the plan's
  biggest risk (a `get_session` closed before the body streams) surfaces here as a
  half-written stream rather than a clean error.
- **Expected**:
  - status **200** (a mid/pre-stream Anthropic failure never changes an already-sent 200);
  - `content-type: text/event-stream`; `cache-control: no-store`;
  - the body ends with **exactly one terminal frame**:
    `event: error` + `data: {"detail":"ANTHROPIC_ERROR"}` — **no `event: done`**;
  - every `data:` line is **one line of valid JSON** (no raw newlines);
  - **no traceback in the server log, no 500, and the connection closes cleanly**
    (an empty body, a hang, or a close without a terminal frame is a **STOP** — a
    client cannot distinguish that from a dropped network).
- **curl**:
```bash
curl -N --no-buffer -s -D /tmp/adv_head.txt -o /tmp/adv_body.txt \
  -X POST $BASE/advisor/ask \
  -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -d '{"question":"Куда уходят мои деньги?"}'
head -1 /tmp/adv_head.txt; grep -i -E 'content-type|cache-control' /tmp/adv_head.txt
cat -A /tmp/adv_body.txt | tail -6            # frame bytes, incl. the blank-line separators
grep -c '^event: done'  /tmp/adv_body.txt     # 0
grep -c '^event: error' /tmp/adv_body.txt     # 1
grep '^data: ' /tmp/adv_body.txt | sed 's/^data: //' | while read -r l; do echo "$l" | jq -e . >/dev/null || echo "NON-JSON DATA LINE: $l"; done
```
- **Note**: with a dummy key there are no `delta` frames, so *incremental* delivery
  is only provable on CFG-K (TC-B2b-8). What this TC does prove — and pytest cannot
  — is that a real client sees a 200 with a well-formed terminal frame and a clean
  close over a real socket.
- **Status**: ⏸ pending

### TC-B2b-5: per-user 429 + rate-limit NAMESPACE isolation (CFG-D, `1/minute`)
- **Server**: CFG-D with `RATE_LIMIT_ENABLED=true ADVISOR_ASK_RATE_LIMIT=1/minute`.
- **What**: the `user_rl_key(namespace)` factory's real failure mode is one shared
  counter across namespaces — an advisor 429 silently killing receipt uploads.
- **Expected**, in order:
  1. A's 1st ask → **200** (error stream, per TC-B2b-4);
  2. A's 2nd ask → **429** `{"detail":"RATE_LIMITED"}`;
  3. A's `POST /receipts` (a different namespace, same user) → **201** — *not* 429;
  4. B's 1st ask → **200** (per-user key, not global/per-IP — both users share
     127.0.0.1, which is the whole reason D10 keys on the account).
- **curl**:
```bash
HA="Authorization: Bearer $TOKEN_A"; HB="Authorization: Bearer $TOKEN_B"; CT='Content-Type: application/json'
curl -s -o /dev/null -w 'A ask1 %{http_code}\n' -X POST $BASE/advisor/ask -H "$HA" -H "$CT" -d '{"question":"тест"}'
curl -s -w ' [A ask2 %{http_code}]\n'           -X POST $BASE/advisor/ask -H "$HA" -H "$CT" -d '{"question":"тест"}'
curl -s -o /dev/null -w 'A receipt %{http_code}\n' -X POST $BASE/receipts -H "$HA"
curl -s -o /dev/null -w 'B ask1 %{http_code}\n' -X POST $BASE/advisor/ask -H "$HB" -H "$CT" -d '{"question":"тест"}'
```
- **Note**: `POST /receipts` needs no body and no MinIO round-trip (`presign_put`
  is pure local SigV4) — the created receipt row is deleted in cleanup.
- **STOP**: a 429 on `POST /receipts` (namespace collision).
- **Status**: ⏸ pending

### TC-B2b-6: history caps + question validation, with accept arms (CFG-D, limits off)
- **Server**: CFG-D, `RATE_LIMIT_ENABLED=false` (429 noise would mask the 422s).
- **Expected**, all `HTTPValidationError`-shaped (`detail[].loc/type`), never 500:
  - **11** turns → 422; **10** short turns → **200** (accept arm);
  - 10 turns whose `content` totals **> 8000** chars → 422; just under → 200;
  - a turn with `role: "system"` → 422 (the `Literal["user","assistant"]` arm);
  - a turn with `content: ""` → 422 (`min_length=1`);
  - `question: ""` and `question: "   "` → 422 (blank after strip — **GAP-5**, the
    custom validator no pytest case currently exercises);
  - `question` of **2001** chars → 422; **2000** chars → 200.
- **curl**:
```bash
H="Authorization: Bearer $TOKEN_A"; CT='Content-Type: application/json'
mk() { python3 -c "
import json,sys
n,c,q=int(sys.argv[1]),int(sys.argv[2]),int(sys.argv[3])
print(json.dumps({'question':'x'*q,'history':[{'role':'user' if i%2==0 else 'assistant','content':'y'*c} for i in range(n)]}))" "$1" "$2" "$3"; }
curl -s -o /dev/null -w 'turns11 %{http_code}\n'  -X POST $BASE/advisor/ask -H "$H" -H "$CT" -d "$(mk 11 10 10)"    # 422
curl -s -o /dev/null -w 'turns10 %{http_code}\n'  -X POST $BASE/advisor/ask -H "$H" -H "$CT" -d "$(mk 10 10 10)"    # 200
curl -s -o /dev/null -w 'chars8010 %{http_code}\n'-X POST $BASE/advisor/ask -H "$H" -H "$CT" -d "$(mk 10 801 10)"   # 422 (8010 > 8000)
curl -s -o /dev/null -w 'chars7990 %{http_code}\n'-X POST $BASE/advisor/ask -H "$H" -H "$CT" -d "$(mk 10 799 10)"   # 200
curl -s -o /dev/null -w 'q2001 %{http_code}\n'    -X POST $BASE/advisor/ask -H "$H" -H "$CT" -d "$(mk 0 1 2001)"    # 422
curl -s -o /dev/null -w 'q2000 %{http_code}\n'    -X POST $BASE/advisor/ask -H "$H" -H "$CT" -d "$(mk 0 1 2000)"    # 200
curl -s -o /dev/null -w 'qblank %{http_code}\n'   -X POST $BASE/advisor/ask -H "$H" -H "$CT" -d '{"question":"   "}'                        # 422
curl -s -o /dev/null -w 'role   %{http_code}\n'   -X POST $BASE/advisor/ask -H "$H" -H "$CT" -d '{"question":"q","history":[{"role":"system","content":"hi"}]}'   # 422
curl -s -H "$H" -H "$CT" -X POST $BASE/advisor/ask -d '{"question":"   "}' | jq -c '.detail[0] | {loc,type}'
```
- **Note**: the 200 accept arms return the CFG-D error stream — status and framing
  are what matter here, not content.
- **Status**: ⏸ pending

### TC-B2b-7: contract honesty on a non-JSON 200 (O-8) + live == committed
- **Expected**:
  - `POST /advisor/ask` 200 `content` has **exactly one** key: `text/event-stream`
    — **no stray `application/json` arm** (FastAPI derives a default JSON arm from
    `response_class`; if one survives, that is **STOP-and-report**, never a
    hand-edit of `openapi.json`);
  - the 200 description carries the SSE event grammar verbatim;
  - responses keys = `200, 422, 429, 503`; **429 and 503 both `$ref` `AdvisorError`**;
  - **422 is `HTTPValidationError` ONLY** — no `anyOf` with `AdvisorError` (the
    advisor has no business 422; Disagreement 3, upheld);
  - `AdvisorAsk`, `AdvisorTurn`, `AdvisorError` components present in
    `openapi.json` and in `schema.d.ts` (the symbols the hand-written `askAdvisor`
    imports);
  - live `/openapi.json` deep-equals committed `apps/api/openapi.json`; the regen
    is committed with the code (`git status --porcelain` empty on both artifacts).
- **curl**:
```bash
curl -s $BASE/openapi.json > /tmp/live_openapi.json
jq -c '.paths["/advisor/ask"].post.responses["200"].content | keys' /tmp/live_openapi.json   # ["text/event-stream"] EXACTLY
jq -c '.paths["/advisor/ask"].post.responses | keys' /tmp/live_openapi.json                  # ["200","422","429","503"]
jq -c '.paths["/advisor/ask"].post.responses["503"].content["application/json"].schema' /tmp/live_openapi.json   # $ref AdvisorError
jq -c '.paths["/advisor/ask"].post.responses["429"].content["application/json"].schema' /tmp/live_openapi.json   # $ref AdvisorError
jq -c '.paths["/advisor/ask"].post.responses["422"].content["application/json"].schema' /tmp/live_openapi.json   # $ref HTTPValidationError, NO anyOf
jq -r '.paths["/advisor/ask"].post.responses["200"].description' /tmp/live_openapi.json
jq -c '[.components.schemas | keys[] | select(startswith("Advisor"))]' /tmp/live_openapi.json
python3 -c "import json;a=json.load(open('/tmp/live_openapi.json'));b=json.load(open('$API/openapi.json'));print('identical', a==b)"
cd $ROOT && git status --porcelain apps/api/openapi.json packages/api-client/src/generated/schema.d.ts
```
- **STOP**: a surviving `application/json` arm on the 200, or contract drift.
- **Status**: ⏸ pending

### TC-B2b-8: **CONDITIONAL, NON-GATING** — one real stream end to end (CFG-K, O-9 half 1)
- **Precondition**: PC-E green **and** senior-lead/PM confirmed the ≤1-call budget.
  **Absent → 🚫 blocked-non-gating (NOT ❌); the scope still passes** (receipts PM
  note 2026-07-29 precedent).
- **Server**: CFG-K — the real `ANTHROPIC_API_KEY`, `RATE_LIMIT_ENABLED=false`,
  `FX_SCHEDULER_ENABLED=false`, `advisor_model` at its dated-Sonnet default.
- **What**: the only thing no other layer covers — the real SDK glue: system prompt
  + `messages.stream` + `text_stream` iteration, and that the response is delivered
  **incrementally** rather than buffered.
- **Expected**: 200, `text/event-stream`, `cache-control: no-store`;
  **≥1 `event: delta`** frame; terminal frame is **`event: done` with `data: {}`**
  and there is **no `event: error`**; concatenated delta text is non-empty Russian
  prose that plausibly reflects fixture F (mentions a category/merchant/goal —
  asserted by *shape and plausibility*, never verbatim: model output is
  nondeterministic); `time_starttransfer` **materially less than** `time_total`
  (proof of streaming, not buffering); the server log has no traceback and no
  closed-session/greenlet error (the plan's headline risk).
- **curl** (exactly one metered call):
```bash
curl -N --no-buffer -s -D /tmp/adv_k_head.txt \
  -w '\n[start=%{time_starttransfer} total=%{time_total}]\n' \
  -X POST $BASE/advisor/ask \
  -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -d '{"question":"На чём мне сократить расходы в следующем месяце?"}' | tee /tmp/adv_k_body.txt
head -1 /tmp/adv_k_head.txt
grep -c '^event: delta' /tmp/adv_k_body.txt   # >= 1
grep -c '^event: done'  /tmp/adv_k_body.txt   # 1
grep -c '^event: error' /tmp/adv_k_body.txt   # 0
grep '^data: ' /tmp/adv_k_body.txt | sed 's/^data: //' | jq -r 'select(.text) | .text' | tr -d '\n' | head -c 600
```
- **Failure handling**: an Anthropic-side failure (quota, network, model retired)
  → 🚫 blocked-non-gating with the observed frame recorded, **not** ❌ — that arm's
  *protocol* is already proven by TC-B2b-4. Only a malformed frame, a missing
  terminal event, or a server traceback is a real ❌/STOP.
- **Status**: ⏸ pending (blocked unless PC-E green)

---

# CT-B3 — CSV export (tier **STANDARD** — lightweight format, no command blocks)

*pytest owns B3-1..5 (columns/major units incl. the RUB-vs-JPY 100× contrast, BOM +
RFC-4180 quoting, ASC order, filters, scope+auth). My live layer owns the things
only a real download shows: the response headers, the raw first bytes on the wire,
and the human Excel check (O-9 half 2). Composed at run time by the executing QA.*

| # | Scenario (one line) | Expected | Owner |
|---|---|---|---|
| CT-B3-1 | Download `GET /transactions/export` with `Authorization: Bearer $TOKEN_A` over fixture F, inspecting response headers | **200**; `content-type: text/csv; charset=utf-8`; `Content-Disposition: attachment; filename="transactions.csv"` (the download affordance — **GAP-6**, unpinned in pytest) | live (QA) |
| CT-B3-2 | First three bytes of the downloaded file (`xxd -l 3`) | `EF BB BF` — the UTF-8 BOM, present exactly once and only at the start | live (QA) |
| CT-B3-3 | First line of the file, after stripping the BOM | Header row **verbatim**: `id,occurred_at,kind,amount,currency,base_amount,base_currency,category,merchant,note`, terminated `\r\n` | live (QA) |
| CT-B3-4 | Row content over fixture F: the RUB row, the CHF row with a stored snapshot, a GBP row with a NULL snapshot, the uncategorized row | major-unit decimal strings (`2000.00`, not `200000`); `base_amount`/`base_currency` **empty** on the NULL-snapshot row (the export shows the stored snapshot, never re-converts); category **name** present; empty cells for null merchant/note | live (QA) |
| CT-B3-5 | Each filter applied singly (`kind`, `category_id`, `from`/`to`) against the unfiltered download | Each strictly narrows the row set; row counts match the equivalent `GET /transactions` query | live (QA) |
| CT-B3-6 | A `category_id` belonging to user B, and `from > to` | **200 with a header row and zero data rows** — never 4xx (decision-l: read filters never error) | live (QA) |
| CT-B3-7 | Row order in the export vs `GET /transactions` for the same set | Export is **chronological ASC**, list is DESC — the deliberate documented deviation, verified as deliberate on the wire | live (QA) |
| CT-B3-8 | No token; and a token passed as a query parameter instead of a header | No token → **401**; no token-in-query affordance exists (D13, non-negotiable) — a query-token request is 401, not 200 | live (QA) |
| CT-B3-9 | Contract: `/transactions/export` 200 content keys in live `openapi.json`; live doc vs committed | Exactly `["text/csv"]`, **no stray `application/json` arm** (O-8, same STOP rule as the SSE 200); live deep-equals committed; regen committed with the code | live (QA) |
| CT-B3-10 | **Excel-Cyrillic manual check (O-9 half 2)**: open the downloaded file in Excel/Numbers with a Cyrillic category name and a Cyrillic note in the fixture | Cyrillic renders intact (not `РџСЂРѕРґ…`), columns split correctly, the quoted note containing a comma/newline stays in one cell | **human/QA at /test** |

- **Status**: all ⏸ pending
- **Note**: CT-B3-10 requires a fixture row with a **Cyrillic category name** (e.g.
  `Продукты`) and a note containing a comma, a quote and a newline — created as
  part of B3's /test setup, on user A, **after** all B1 pins are recorded (or on a
  throwaway user, which is cleaner and is the default).

---

## STOP rules — what aborts the session

| Trigger | Ruling |
|---|---|
| **Any 5xx anywhere** (other than the *designed* 503 `AI_NOT_CONFIGURED`) — including a traceback in the server log on a 200 stream | **STOP** |
| 503 body/content-type not byte-exactly `{"detail":"AI_NOT_CONFIGURED"}` + `application/json`, or served as a stream | **STOP** — the binding UI contract is keyed on these bytes |
| A 429 where the unkeyed server must answer 503 (quota consumed by the gate) | **STOP** — Disagreement 1 broken, the button lies to the user |
| An SSE response with **no terminal event**, more than one terminal event, a `data:` line that is not one-line JSON, or a connection closed mid-stream | **STOP** — a client cannot distinguish these from a network failure |
| 401 not winning over the 503 gate (anonymous caller learns the key state) | **STOP** |
| `openapi.json` 200 arm carrying a stray `application/json` for the SSE or the CSV route | **STOP-and-report** (O-8) — never hand-edit the artifact |
| Live `/openapi.json` ≠ committed `apps/api/openapi.json`, or a non-empty `git status` on either contract artifact | **STOP** — contract drift |
| Any **non-empty** contract diff produced by B2a | **STOP** (O-5 is B2a's acceptance gate) |
| Any hand-pinned number in TC-B1-3/-4/-5 mismatching, or `/stats/summary` ≠ `/transactions/summary` for the same month | **STOP** — a second aggregation implementation exists |
| Any 4xx on a read-filter edge that decision-l promises as an empty 200 (`from>to`, foreign `category_id`) | **STOP** |
| An `alembic` migration pending or authored in this scope | **STOP-and-escalate** — the scope is DDL-free by design |
| Anthropic unreachable / quota exhausted on **CFG-K only** | 🚫 **blocked-non-gating**, re-run when a key is available — **not** a failure |
| A provider/`exchange_rates` anomaly | not applicable: this scope makes **zero** external FX calls; rates are a psql-seeded fixture |

**Latency**: I record `%{time_total}` on every stats call. It is **not** a STOP —
the >100 ms re-arm trigger belongs to obligation O-1 (B1's `EXPLAIN ANALYZE`) — but
a stats endpoint over 100 ms at fixture scale gets reported to senior-lead.

---

## What I explicitly do NOT test (and why)

- **Anything the seam-mocked pytest already proves** — period math, bucket algebra,
  the SSE framing at the ASGI-transport level, the no-raw-transactions prompt pin,
  the exponent rendering. My live TCs exist for real-wire and cross-request value,
  never re-assertion.
- **The real `Advisor` class against a mocked `AsyncAnthropic`** — the codebase's
  strategy is the seam fake (no such test exists for `ReceiptParser` either); the
  SDK glue is verified once, live, in TC-B2b-8.
- **Advisor answer content** — nondeterministic model output; shape and
  plausibility only.
- **`EXPLAIN ANALYZE` / index plans** — obligation O-1, owned by B1's /implement
  report, not by QA.
- **Goals progress via `/stats`** — there is no `/stats/goals` by design (D4); the
  shipped goals endpoints are already covered by the currencies-goals checklist.
- **4.2 web screens and the hand-written `askAdvisor`** — web-qa owns them; my
  contract and code checks underwrite them.
- **Mobile (4.3)** — frozen.
- **Concurrency/races on the limiter** — two interleaved live curls prove nothing
  reliably (the currencies-goals FOR-UPDATE verdict); review-verified.

---

## Open questions for senior-lead (before /test starts)

1. **GAP-3 ruling**: does a *redundant but correct* anchor (`period=month&month=…&quarter=…`)
   422 or is it ignored? Recommendation: **ignore extras** (a client switching tabs
   leaves stale params behind). Until ruled, TC-B1-2 records the behaviour without
   failing on it.
2. **CFG-K authorization**: is an `ANTHROPIC_API_KEY` available at /test, and is the
   **≤1 metered Sonnet call** budget approved? If not → TC-B2b-8 is 🚫
   blocked-non-gating and the scope still passes (2026-07-29 PM precedent).
3. **CFG-D dummy-key network egress**: confirm it is acceptable that TC-B2b-4/5/6
   send authentication-failing requests to `api.anthropic.com` (**zero tokens
   billed**, receipts S3 precedent). If not, the same TCs run offline — the
   `ConnectError` path yields the identical 200 + `event: error` frame.
4. **Gaps 1, 2, 4, 5, 6, 7**: which land as pytest arms in the plan (my
   recommendation for all six — each is one assertion), and which stay live-only?

---

## Final report (filled at each subtask's /test)

```
### Section A (pytest)
- Total: N · ✅ Pass: N · ❌ Fail: N — (list)

### Section B (curl)
- Total: N · ✅ Pass: N · ❌ Fail: N — (list) · 🚫 Blocked: N — (list + reason)

**Overall**: ✅ READY FOR REVIEW / ❌ FAIL — escalate to senior-lead
```

Per subtask: Total / Passed / Failed (list) / Blocked (list + reason), plus the
STOP-trigger line ("no STOP triggered" or which one fired), the live-call
accounting for B2b (metered Sonnet calls spent, cap 1), and the cleanup line
(run-scoped users deleted, `DELETE FROM exchange_rates WHERE base='CHF'` done,
`exchange_rates` verified back to canonical-6-pairs-only, port 8010 free).
Any ❌ → **FAIL OVERALL**, senior-lead handles (I do not fix backend code).
A 🚫 on **TC-B2b-8 only** does **not** fail the scope.

- **B1**: ✅ READY FOR REVIEW — Section A 226/226 pytest green; Section B 8/8 (TC-Z1 + TC-B1-1..7) ✅, 0 ❌, 0 🚫; no STOP triggered; latency max 11.4 ms; cleanup done (CHF rate deleted, exchange_rates back to canonical 6 pairs, user B's MAX rows removed, port 8010 free). Fixture F on user A kept for B2b reuse.
- **B2a**: ⏸ pending
- **B2b**: ⏸ pending
- **B3**: ⏸ pending
