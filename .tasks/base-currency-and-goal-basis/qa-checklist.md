# QA Checklist: base-currency-and-goal-basis (groomed 2026-08-22)

## Scope

API-level only (web checked separately by web-qa). Covers D1 (`base_currency` +
`monthly_income_minor` become writable on `PATCH /profile`) and D2 (free-balance
basis resolution in `GET /goals`), plus the blast radius of a base switch on the
readers that share `services/tx_totals.py` (transactions summary, /stats, /limits,
/goals).

Does NOT cover: FX fetching itself, goal CRUD/progress, web UI copy, mobile
(frozen). Does NOT re-litigate scoping/no-oracle/rate limits — see
"Deliberately NOT in the program" at the bottom.

**15 scenarios: 11 pytest-owned (backend-engineer, B1), 5 live-curl (qa-engineer;
TC-11 is both).** Live run estimate: **20-30 agent-minutes** (seeding accounts +
back-dated transactions dominates; one login per user, reused).

Users: `qa-basecur@budgetqa.dev` (switch + aggregates), `qa-goalbasis@budgetqa.dev`
(virgin, for the basis ladder). Password `Qa!Test1234`. API `http://localhost:8010`.

---

## Section A — pytest test cases (owned by backend-engineer)

### TC-1 [pytest] Base switch is accepted and persists
- **Intent**: `PATCH /profile {"base_currency": "BYN"}` for a RUB user.
- **Expected**: 200, body `base_currency == "BYN"`; a following `GET /profile`
  echoes BYN (write actually committed, not just serialized).

### TC-2 [pytest] Unsupported currency is refused with the domain code
- **Intent**: `base_currency` = `"JPY"` (valid exponent-table entry, NOT in the
  supported four), `"XXX"`, `"byn"` (lowercase), `"RUBB"`.
- **Expected**: 422 with `detail == "CURRENCY_NOT_SUPPORTED"` for well-formed
  unsupported codes; never 500, never silently ignored. Stored base unchanged.

### TC-3 [pytest] null is refused, omit keeps — contrast in one test
- **Intent**: `{"base_currency": null}` vs `{"language": "en"}` (base omitted) on
  the same user.
- **Expected**: null → 422 (NOT nullable, unlike `country`/`language`); omit → 200
  and the stored base is untouched.
- **Note for B1**: `tests/test_profile.py::test_base_currency_is_not_writable_here`
  asserts the OLD behaviour (sent value ignored, stays RUB). It must be REWRITTEN
  into TC-1/TC-3, not deleted quietly.

### TC-4 [pytest] monthly_income_minor set / clear / reject
- **Intent**: set `250000`; then `null`; then `-1`; then `0`.
- **Expected**: set → 200 echoed and persisted; null → 200, field back to `null`
  (clear, house rule); `-1` → 422 at the schema (never an IntegrityError 500 from
  the `>= 0` CHECK); `0` → 200 (0 is a declared income of zero, distinct from null).

### TC-5 [pytest] Supported-currency list twin does not drift
- **Intent**: python `SUPPORTED_CURRENCIES` vs `packages/shared/src/currencies.ts`.
- **Expected**: identical sets — same pin pattern as
  `tests/test_currency_exponents_sync.py`. A code the web offers but the API
  refuses is a live 422 the user cannot resolve.

### TC-6 [pytest] basis "declared" — the actual reported defect
- **Intent**: user with ZERO transactions in the 3 full months, `monthly_income_minor
  = 250000`; `GET /goals`.
- **Expected**: `free_balance_minor == 250000`, `free_balance_basis == "declared"`.

### TC-7 [pytest] basis "none"
- **Intent**: same user with `monthly_income_minor` unset/null.
- **Expected**: `free_balance_minor == 0`, `free_balance_basis == "none"` (0 alone
  is ambiguous — the label is what the UI branches on).

### TC-8 [pytest] basis "average" divides by months WITH data (known edge)
- **Intent**: rows in exactly ONE of the 3 full months, `monthly_income_minor` ALSO
  set; plus a sub-case where a month has only unconverted rows
  (income=expense=0, `unconverted_count > 0`).
- **Expected**: divisor is 1, not 3; basis `"average"` — declared does NOT win when
  any month has data; the unconverted-only month counts as having data (otherwise
  real activity is invisible and the declared number silently replaces it).

### TC-9 [pytest] With-history user unchanged (regression pin)
- **Intent**: the existing 3-full-month fixture (`tests/test_goals_api.py:305,546`).
- **Expected**: `free_balance_minor == 3_000_000` as before, now with
  `free_balance_basis == "average"`. D2 must not move the math for real users.

### TC-10 [pytest] tx_totals after a base switch — convert vs count, contrast
- **Intent**: base switched RUB→BYN, then one row `currency=RUB, base_currency=RUB`
  (stale snapshot) and one row in a currency with NO rate to BYN, in the same window.
- **Expected**: the stale-snapshot row is CONVERTED at read time into the BYN totals
  (bucket 3, not summed raw as if it were BYN); the rateless row is excluded from
  the sums and counted in `unconverted_count` (never dropped, never zero-summed).
  Both arms in one test — the contrast is the point.

### TC-11 [pytest + curl] /profile stays JWT-only after gaining money fields
- **Intent**: PAT bearer on `PATCH /profile {"base_currency": "USD"}`.
- **Expected**: 401 (JWT decode failure, no PAT allowlist entry) — a read-scope PAT
  must not be able to redefine the base currency of every aggregate. Extends
  `tests/test_profile.py::TestAuth`; re-probed live as part of TC-12.

---

## Section B — live curl (owned by qa-engineer)

Preconditions: API up on :8010 with `FX_SCHEDULER_ENABLED=false
RECURRING_SCHEDULER_ENABLED=false`; `exchange_rates` populated for RUB/BYN/USD/EUR
(verify via `GET /fx/convert`, see TC-12). LOGIN ONCE per user; reuse `$TOKEN`.

### TC-12 [curl] Server boots, switch works end to end, PAT still refused
- **Intent**: login once as `qa-basecur@budgetqa.dev`; probe `GET /fx/convert`
  RUB→BYN (rate data present?); `PATCH /profile {"base_currency":"BYN"}`;
  `GET /profile`; `GET /goals`; then the same PATCH with a PAT bearer.
- **Expected**: convert 200 with a non-null rate (else TC-13 is BLOCKED, not failed);
  PATCH 200 BYN; GET /profile BYN; `GET /goals` → `base_currency: "BYN"`; PAT
  attempt → 401.
- **curl**:
```bash
BASE=http://localhost:8010
TOKEN=$(curl -s -X POST $BASE/auth/login \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'username=qa-basecur@budgetqa.dev&password=Qa!Test1234' | jq -r '.access_token')
curl -s "$BASE/fx/convert?amount_minor=100000&from_currency=RUB&to_currency=BYN" -H "Authorization: Bearer $TOKEN"
curl -s -X PATCH $BASE/profile -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"base_currency":"BYN"}'
curl -s $BASE/profile  -H "Authorization: Bearer $TOKEN"
curl -s $BASE/goals    -H "Authorization: Bearer $TOKEN" | jq '{base_currency, free_balance_minor, free_balance_basis}'
curl -s -o /dev/null -w '%{http_code}\n' -X PATCH $BASE/profile \
  -H "Authorization: Bearer bgt_pat_deadbeef" -H 'Content-Type: application/json' \
  -d '{"base_currency":"USD"}'
```
- **Status**: ⏸ pending

### TC-13 [curl] Every reader survives the switch and stays currency-honest
- **Depends on TC-12** (same user, switched to BYN; seed rows BEFORE switching back
  to RUB → BYN if the account/tx seeding is done fresh).
- **Intent**: seed a RUB account + one RUB expense dated in a full month (snapshot
  written while base was RUB) and one expense on a JPY account (no rate → no
  snapshot); switch base to BYN; then read `GET /transactions/summary`,
  `GET /stats/summary`, `GET /stats/monthly`, `GET /limits`, `GET /goals`.
- **Expected**: all 200 (no 500 anywhere — this is the one thing pytest fixtures
  cannot prove about the deployed wiring); every response reports base BYN; the RUB
  row's contribution is CONVERTED (BYN total is roughly amount×rate, NOT the raw RUB
  minor integer relabelled); the JPY row is absent from the sums and shows up as
  `unconverted_count >= 1` (and `realism_unavailable: true` on /goals). The user-
  visible number must not silently 30x.
- **curl**: seed via `POST /accounts`, `POST /transactions` with `occurred_at` in the
  previous full month; then
```bash
for p in "/transactions/summary?period=month" "/stats/summary?period=month" \
         "/stats/monthly" "/limits" "/goals"; do
  echo "== $p"; curl -s -w '\n%{http_code}\n' "$BASE$p" -H "Authorization: Bearer $TOKEN"
done
```
- **Status**: ⏸ pending

### TC-14 [curl] The defect's own ladder: none → declared → average, live
- **Intent**: fresh `qa-goalbasis@budgetqa.dev` with no history: `GET /goals`;
  `PATCH /profile {"monthly_income_minor": 250000}`; `GET /goals`; then post ONE
  transaction dated inside a full month; `GET /goals` again.
- **Expected**: (1) `0` / `"none"`; (2) `250000` / `"declared"`; (3) basis flips to
  `"average"` computed over that ONE month (the accepted known edge) — verify the
  number equals income−expense of that single month, not /3. This is the exact
  sequence the live user performs; pytest proves the math, this proves the whole
  path answers it over real HTTP.
- **Status**: ⏸ pending

### TC-15 [curl] The browser gets a usable error, not a 500 or a CORS wall
- **Intent**: `PATCH /profile` with `{"base_currency":"JPY"}`, `{"base_currency":null}`,
  `{"monthly_income_minor":-1}`; plus an `OPTIONS` preflight for PATCH /profile with
  an Origin header.
- **Expected**: 422 each, `detail` = `"CURRENCY_NOT_SUPPORTED"` for JPY and the
  standard validation payload for the other two (the `anyOf` union renders honestly
  on the real server); preflight 200/204 with PATCH in `access-control-allow-methods`.
  Duplicates TC-2/TC-3 deliberately: those prove the rule, this proves the envelope
  and the CORS verb list the browser actually hits (the `PUT /limits` precedent).
- **Status**: ⏸ pending

---

## Deliberately NOT in the live program (and what covers it)

| Not run live | Covered by |
|---|---|
| Foreign/missing ids, no-oracle 404 on /goals, /profile | existing `tests/test_goals_api.py`, `tests/test_profile.py`; this scope adds no new id-addressed surface |
| `user_id` scoping of goals/transactions/limits | existing per-router scoping tests; unchanged by D1/D2 |
| Boundary values on `monthly_income_minor` (max int, huge strings) | TC-4 (pytest) + the model's `>= 0` CHECK |
| PATCH idempotency (same body twice) | TC-3 omit-vs-value contrast; PATCH is a plain field write with no side effects |
| Auth-missing/expired token on /profile | `tests/test_profile.py::TestAuth` (one router, shared dependency) |
| Rate limits | unchanged by this scope |
| Goal CRUD, contributions, progress series | existing `tests/test_goals_api.py` |
| FX fetch/lookup correctness | `tests/test_fx_rates.py`, `tests/test_fx_jobs.py`, `tests/test_fx_convert.py` |

---

## Open questions / risks raised at grooming (for senior-lead)

1. **Declared income has no currency of its own — RULED (senior-lead
   2026-08-22, plan.md Amendment A1):** a base switch CLEARS
   `monthly_income_minor` server-side. Arm-order behaviour is pytest-owned in B1:
   (a) switch clears income; (b) switch + income in the SAME PATCH keeps the sent
   value; (c) same-value switch keeps income. Live observation folds into TC-13:
   after the switch, `GET /profile` shows `monthly_income_minor: null`.
   SEQUENCING NOTE for the live run: TC-14's ladder must (re-)set income AFTER
   any base switch performed in TC-12/TC-13, or its "declared" rung will
   correctly read "none".
2. **A month containing only transfers reads as "no data" — RULED (senior-lead
   2026-08-22, task.md D2):** intended. Transfers are movement between own
   accounts, zero signal about saving capacity; TC-8 asserts basis="declared"
   for the transfers-only user. (Original concern kept for the record:
   confirm before TC-8 asserts it either way.
3. **The "no rate to the new base" arm is only reachable via an out-of-list account
   currency** (all four supported currencies have full pair coverage). TC-10/TC-13
   use a JPY account. If account currency is ever restricted to
   `SUPPORTED_CURRENCIES`, that arm becomes untestable and the honest-unconverted
   guarantee loses its live probe.

---

## Run summary (filled at /test)

- Total: 15 (pytest 11, live curl 5, TC-11 both)
- Passed: —
- Failed: —
- Blocked: —
- Status: ⏸ NOT RUN (grooming artifact)
