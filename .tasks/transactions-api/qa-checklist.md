# QA Checklist: transactions-api (roadmap 1.4)

## Scope

Live-wire (curl) verification of the five transaction routes mounted at prefix
`/transactions` per the accepted **plan.md**:

| Method | Path | Success |
|---|---|---|
| POST | `/transactions` | 201 `TransactionRead` |
| GET | `/transactions` | 200 `TransactionList` |
| GET | `/transactions/summary` | 200 `SummaryRead` |
| PATCH | `/transactions/{transaction_id}` | 200 `TransactionRead` |
| DELETE | `/transactions/{transaction_id}` | 204 (no body) |

Plus a **categories regression smoke** (TC-25) after the `category_access.py`
extraction refactor, and the **contract-artifact drift/same-commit gates**
(TC-23/24). This checklist is written at **grooming**; it is executed at **/test
after /implement**. Do NOT run curl now.

**This is Section B (curl, QA-owned).** Section A (pytest) is owned by
backend-engineer per plan.md's **Test plan** (`tests/test_transactions.py`,
tests 1–16). At /test I also run the full pytest suite and confirm it is green
(TC-Z1); I do not write or fix that code.

**Binding senior amendments this checklist is written against** (plan folds them
at /implement):
- **AM-1** — pytest test 15 (summary on a profile-DELETED user) pins the
  read-only RUB fallback AND that the GET creates no `profiles` row.
  pytest-owned; **not duplicated here**, but TC-21's summary check notes the
  RUB-fallback wire effect (see TC-21 note).
- **AM-2** — profile get-or-create PK race accepted in writing (single-user
  app). **Out of QA scope — not flagged as a finding.**
- **AM-3** — skeleton import nit, folded at implement. Ignored.
- **AM-4** — **extra-field silent-ignore is DECIDED behavior and QA-PINNED**:
  `POST /transactions` with `"currency":"USD"` in the body → **201** and response
  `currency == "RUB"` (profile base); the USD is silently ignored (Pydantic
  default, no `extra=forbid`). → **TC-4** (explicit wire pin of the decision).

**Out of scope here (pytest owns; see Division of labor at the end):** the
custom-logic paths in plan.md's Test plan (tests 1–16) — forced-ownership DB
assertion internals, self-heal create-branch (test 2), summary correctness
math (test 14), `model_fields_set` omitted-vs-null mechanics, cross-user read
isolation, kind CHECK-constraint enforcement (1.2 `test_core_model.py`), the
model↔migration byte-identity (senior diff gate + `alembic check`), the
get-or-create PK race (AM-2). My curl checks exist to add **live-wire** value
(real HTTP, real error envelopes, byte-identical no-oracle bodies, the AM-4
wire decision, contract drift) — not to re-assert pytest.

## Stable detail codes (business errors, `{"detail":"<CODE>"}` string envelope)

| Code | Status | Where |
|---|---|---|
| `CATEGORY_NOT_FOUND` | 422 | POST/PATCH body `category_id` foreign OR missing → **byte-identical** |
| `CATEGORY_ARCHIVED` | 422 | POST/PATCH body `category_id` points at an archived (own, visible) category |
| `TRANSACTION_NOT_FOUND` | 404 | PATCH/DELETE path id cross-user OR missing → **byte-identical** |
| `AMOUNT_REQUIRED` | 422 | PATCH `{"amount_minor": null}` (NOT-NULL column, explicit null) |
| `KIND_REQUIRED` | 422 | PATCH `{"kind": null}` |
| `OCCURRED_AT_REQUIRED` | 422 | PATCH `{"occurred_at": null}` |

**Envelope contrast (load-bearing — the string-vs-array `detail` distinction is
itself the contract, mirroring 1.3):**
- **Business errors** (the table above) return `detail` as a **string code**:
  `{"detail":"CATEGORY_NOT_FOUND"}`.
- **Pydantic/param rejections** (`amount_minor` `ge=1`, invalid `kind` enum,
  malformed `occurred_at`/`from`/`to`/`month`, `note` > 500, `limit` > 200,
  `offset` < 0) return `detail` as an **array** of error objects:
  `{"detail":[{"type":...,"loc":...,"msg":...}]}`.

Several TCs assert **which** shape appears. Critically, `amount_minor:0` and
`amount_minor:-1` are `ge=1` **Field constraints** → **Pydantic ARRAY 422**, NOT
our string-code `CATEGORY_*`. TC-5 diffs that shape explicitly (the wire-shape
check that contrasts with our string-code 422s).

---

## Preconditions

Run once at the start of /test; keep the shell env for the chained TCs.

### Environment

```bash
export BASE=http://localhost:8010                 # confirm the /test port with senior (1.3 used 8010); see Uncertainty U1
export PGURI='postgresql://budget:budget@localhost:5443/budget'   # live server DB (5443, db `budget`)
psql_q() { PGPASSWORD=budget psql -h localhost -p 5443 -U budget -d budget -tAc "$1"; }
```

> **5443/5433 split (standing rule):** the committed `docker-compose.yml` maps
> `5433:5432`, but `apps/api/.env` points the live app at **5443** (standing
> local PG). The running uvicorn server reads/writes `…@localhost:5443/budget`.
> All psql verification below targets 5443/`budget` (the app's live DB), NOT
> `budget_test` (pytest's DB on the same server). Do NOT edit
> `conftest.py`/`docker-compose.yml` — env-only setup, mirror 1.3.
>
> **Server start (mirror 1.3 /test):** QA starts it via
> `uv run uvicorn budget_api.app:create_app --factory --port 8010` from
> `apps/api`, after confirming `apps/api/.env` → `…@localhost:5443/budget`. If
> the live `budget` DB is pre-`0002`/`0003`, `alembic upgrade head` (env setup,
> not a code change) brings up the `transactions` table + 18 seeds.

### PC-1 — server up (liveness + real DB round-trip) — STOP rule

```bash
curl -s -o /dev/null -w '%{http_code}\n' $BASE/health
curl -s $BASE/health
```
- **Expected**: `200`, body `{"status":"ok","database":"ok"}`. If not 200 →
  **STOP**: the server/DB is not ready; report to senior-lead. Everything below
  is blocked.

### PC-2 — DB reachable for verification queries — STOP rule (partial)

```bash
psql_q 'SELECT 1'
```
- **Expected**: `1`. If it errors → the psql cross-checks (forced-ownership DB
  check, delete-row-gone check, self-heal profile row check) are ⏸ blocked; the
  pure-HTTP assertions of those TCs still run.

### PC-3 — register + login users, capture tokens + ids

Login is **form-encoded** (1.1 carry-forward): `username` = the email. Unique
emails per run avoid `REGISTER_USER_ALREADY_EXISTS` from leftover rows in the
shared live `budget` DB.

```bash
export RUN=$(date +%s)
export EMAIL_A="qa_tx_a_${RUN}@x.com"
export EMAIL_B="qa_tx_b_${RUN}@x.com"
export PW="password123"

curl -s -o /dev/null -w 'regA %{http_code}\n' -X POST $BASE/auth/register \
  -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL_A\",\"password\":\"$PW\"}"
curl -s -o /dev/null -w 'regB %{http_code}\n' -X POST $BASE/auth/register \
  -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL_B\",\"password\":\"$PW\"}"

export TOKEN_A=$(curl -s -X POST $BASE/auth/login --data "username=$EMAIL_A&password=$PW" | jq -r '.access_token')
export TOKEN_B=$(curl -s -X POST $BASE/auth/login --data "username=$EMAIL_B&password=$PW" | jq -r '.access_token')
export A_ID=$(curl -s $BASE/users/me -H "Authorization: Bearer $TOKEN_A" | jq -r '.id')

echo "A_ID=$A_ID  TOKEN_A=${TOKEN_A:0:12}…  TOKEN_B=${TOKEN_B:0:12}…"
```
- **Expected**: `regA 201`, `regB 201`; both logins yield a non-empty
  `access_token`; `A_ID` is a UUID. If any is empty → **STOP**, downstream TCs
  are blocked.

### PC-4 — own categories + seed reference available (chained setup)

A/B each get an **own** expense + income category (per-test isolation, plan Test
plan convention). Also confirm the 18 system seeds are present (the summary
uncategorized/refund logic and the archived-category check depend on real
category rows).

```bash
mkcat() { # $1=token $2=name $3=kind -> prints id
  curl -s -X POST $BASE/categories -H "Authorization: Bearer $1" \
    -H 'Content-Type: application/json' -d "{\"name\":\"$2\",\"kind\":\"$3\"}" | jq -r '.id'; }

export A_EXP=$(mkcat "$TOKEN_A" "qa-tx-exp-$RUN" expense)
export A_INC=$(mkcat "$TOKEN_A" "qa-tx-inc-$RUN" income)
export B_EXP=$(mkcat "$TOKEN_B" "qa-tx-bexp-$RUN" expense)
export SEED_EXP='ce814749-2554-40be-8952-3a63d505694f'   # Продукты / expense (system seed)

# archived own category for the CATEGORY_ARCHIVED path (TC-10 / TC-13b):
export A_ARCH=$(mkcat "$TOKEN_A" "qa-tx-arch-$RUN" expense)
curl -s -o /dev/null -X PATCH $BASE/categories/$A_ARCH -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' -d '{"archived":true}'

echo "A_EXP=$A_EXP A_INC=$A_INC B_EXP=$B_EXP A_ARCH=$A_ARCH"
psql_q "SELECT count(*) FROM categories WHERE user_id IS NULL"    # 18
```
- **Expected**: all five ids are UUIDs; `A_ARCH` archived; seed count `18`. If
  `A_EXP`/`B_EXP` are empty → **STOP** (categories router broken, blocks the
  write-path category-ref TCs).

---

## Test cases

### TC-1: Auth wall — 401 status-only across every method group
- **What**: every transactions route rejects an unauthenticated request with
  `401` (router-level `current_active_user`; auth runs **before** body/param
  validation, so a missing token is 401, never 422).
- **Expected**: all five → `401`. **STATUS-ONLY** (grooming-review §3 R1): do NOT
  pin the response body — the 401 prose is fastapi-users transport internals, not
  our contract.
- **curl**:
```bash
curl -s -o /dev/null -w 'POST    %{http_code}\n' -X POST $BASE/transactions \
  -H 'Content-Type: application/json' -d '{"amount_minor":100,"kind":"expense","occurred_at":"2026-05-01"}'
curl -s -o /dev/null -w 'GETlist %{http_code}\n' $BASE/transactions
curl -s -o /dev/null -w 'SUMMARY %{http_code}\n' "$BASE/transactions/summary?month=2026-05"
curl -s -o /dev/null -w 'PATCH   %{http_code}\n' -X PATCH \
  $BASE/transactions/00000000-0000-0000-0000-000000000000 \
  -H 'Content-Type: application/json' -d '{"amount_minor":1}'
curl -s -o /dev/null -w 'DELETE  %{http_code}\n' -X DELETE \
  $BASE/transactions/00000000-0000-0000-0000-000000000000
# each -> 401
```
- **Status**: ✅ pass

### TC-2: POST happy path — 201, currency stamped RUB, no user_id on wire, forced ownership
- **Depends on**: PC-3 (A_ID), PC-4 (A_EXP).
- **Method/Endpoint**: POST `/transactions`, `Authorization: Bearer $TOKEN_A`
- **Body**: valid create against own category:
```json
{"amount_minor":12345,"kind":"expense","category_id":"<A_EXP>","occurred_at":"2026-03-15","note":"lunch"}
```
- **Expected**: `201`. Response has keys `id, amount_minor, kind, currency,
  category_id, occurred_at, note, created_at`; `currency == "RUB"` (base stamped,
  never wire input); `amount_minor==12345`, `kind=="expense"`,
  `category_id==$A_EXP`, `note=="lunch"`; **no `user_id` key on the wire**
  (`TransactionRead` omits it). DB: stored `user_id == $A_ID` (forced ownership —
  the wire can't prove this).
- **curl + DB check**:
```bash
TX=$(curl -s -X POST $BASE/transactions -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' \
  -d "{\"amount_minor\":12345,\"kind\":\"expense\",\"category_id\":\"$A_EXP\",\"occurred_at\":\"2026-03-15\",\"note\":\"lunch\"}")
echo "$TX" | jq '{currency, amount_minor, kind, category_id, note, has_user_id: has("user_id")}'
#   expect currency "RUB", has_user_id false, echoed fields
export TX2_ID=$(echo "$TX" | jq -r '.id')
psql_q "SELECT user_id='$A_ID' FROM transactions WHERE id='$TX2_ID'"      # t (forced ownership)
```
- **Status**: ✅ pass

### TC-3: POST null category → 201 uncategorized
- **Method/Endpoint**: POST `/transactions`, `Authorization: Bearer $TOKEN_A`
- **Expected**: `201`, `category_id == null` (the uncategorized path the summary
  later buckets under `category_id: null`). No category validation runs on null.
- **curl**:
```bash
curl -s -X POST $BASE/transactions -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' \
  -d '{"amount_minor":500,"kind":"expense","category_id":null,"occurred_at":"2026-03-16"}' \
  | jq '{status:"201?", category_id}'
#   expect category_id null
```
- **Status**: ✅ pass

### TC-4: POST with extra `"currency":"USD"` → 201, currency==RUB (AM-4 wire pin)
- **What**: **AM-4** — extra body fields are silently ignored (Pydantic default,
  no `extra=forbid`). The USD is dropped; the server stamps the profile base.
- **Expected**: `201`; response `currency == "RUB"` (NOT `"USD"`). Documents the
  decision on the wire — an unknown field neither errors (422) nor leaks.
- **curl**:
```bash
curl -s -X POST $BASE/transactions -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' \
  -d '{"amount_minor":700,"kind":"expense","occurred_at":"2026-03-17","currency":"USD"}' \
  | jq '.currency'
#   expect "RUB" (USD silently ignored; 201, not 422)
```
- **Status**: ✅ pass

### TC-5: POST amount_minor 0 and -1 → 422 **Pydantic ARRAY** (ge=1 wire-shape; contrast with string codes)
- **What**: `Field(ge=1)` (decision h) — zero and negative are a **Pydantic Field
  constraint** violation → `422` with `detail` as an **ARRAY**, NOT our
  string-code envelope. This is the wire-shape check that contrasts with the
  `CATEGORY_*`/`*_REQUIRED` string-code 422s. (Zero also has a pytest pin, test 6
  — the deferred-policy regression guard; my curl proves the live wire shape.)
- **Expected**: both `422`; `detail | type == "array"`.
- **curl**:
```bash
for A in 0 -1; do
  curl -s -o /dev/null -w "amount=$A -> %{http_code}\n" -X POST $BASE/transactions \
    -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' \
    -d "{\"amount_minor\":$A,\"kind\":\"expense\",\"occurred_at\":\"2026-03-18\"}"
done                                                                       # each -> 422
curl -s -X POST $BASE/transactions -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' \
  -d '{"amount_minor":0,"kind":"expense","occurred_at":"2026-03-18"}' \
  | jq 'if (.detail|type)=="array" then "pydantic-array-OK" else {LEAK:.} end'
#   expect "pydantic-array-OK" (NOT a string code)
```
- **Status**: ✅ pass

### TC-6: POST invalid `kind` value → 422 Pydantic array
- **Expected**: `422`, `detail` array. `kind="transfer"` is not in
  `TransactionKind` = {expense, income} (a value stage-5 adds to transactions
  only — decision c; today it is rejected).
- **curl**:
```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST $BASE/transactions \
  -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' \
  -d '{"amount_minor":100,"kind":"transfer","occurred_at":"2026-03-19"}'   # 422
```
- **Status**: ✅ pass

### TC-7: POST `occurred_at` — malformed → 422 Pydantic array; future date → 201 (AM-7 decision-g pin)
- **What**: only a *malformed* date errors; **any well-formed date, including a
  future one, IS accepted** (decision g). AM-7 pins the allowed-contrast case: a
  deliberate "future dates allowed" decision that a well-meaning future guard
  could silently reverse gets a live wire pin here (no pytest — no-custom-logic
  pass-through).
- **Expected**:
  - malformed (`2026-13-40`, `not-a-date`, `2026/03/01`) → each `422`, `detail`
    array.
  - future date (`2030-01-01`) → `201` (accepted, no rejection).
- **curl**:
```bash
for D in '"2026-13-40"' '"not-a-date"' '"2026/03/01"'; do
  curl -s -o /dev/null -w "occurred_at=$D -> %{http_code}\n" -X POST $BASE/transactions \
    -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' \
    -d "{\"amount_minor\":100,\"kind\":\"expense\",\"occurred_at\":$D}"
done                                                                       # each -> 422
# AM-7: future date is an allowed happy case, not an error:
curl -s -o /dev/null -w 'occurred_at=2030-01-01 -> %{http_code}\n' -X POST $BASE/transactions \
  -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' \
  -d '{"amount_minor":100,"kind":"expense","occurred_at":"2030-01-01"}'   # 201 (future allowed)
```
- **Status**: ✅ pass

### TC-8: POST `note` boundary — >500 → 422; exactly 500 → 201; whitespace-only → stored null
- **What**: `note` cap 500 **after strip**, empty-after-strip → `None` (decision
  i). The cap is a `ValueError` in the field_validator → Pydantic **array** 422.
- **Expected**:
  - 501-char note → `422` (array detail).
  - exactly-500-char note → `201`, `note` is the 500-char string.
  - whitespace-only `"   "` → `201`, `note == null` (empty-after-strip).
- **curl**:
```bash
N501=$(printf 'x%.0s' {1..501}); N500=$(printf 'x%.0s' {1..500})
curl -s -o /dev/null -w 'note501 -> %{http_code}\n' -X POST $BASE/transactions \
  -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' \
  -d "{\"amount_minor\":100,\"kind\":\"expense\",\"occurred_at\":\"2026-03-20\",\"note\":\"$N501\"}"   # 422
curl -s -X POST $BASE/transactions -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' \
  -d "{\"amount_minor\":100,\"kind\":\"expense\",\"occurred_at\":\"2026-03-20\",\"note\":\"$N500\"}" \
  | jq '.note | length'                                                    # 500 (201)
curl -s -X POST $BASE/transactions -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' \
  -d '{"amount_minor":100,"kind":"expense","occurred_at":"2026-03-20","note":"   "}' \
  | jq '.note'                                                             # null (201)
```
- **Status**: ✅ pass

### TC-9: POST foreign category id AND random uuid → both 422 `CATEGORY_NOT_FOUND`, BYTE-IDENTICAL (no-oracle)
- **Depends on**: PC-4 (B_EXP is user B's category), TOKEN_A.
- **What**: **the category-ref no-oracle pin.** A body `category_id` that is
  another user's (`B_EXP`) and one that is a random UUID must be
  **indistinguishable** — `load_visible_category` returns `None` for both, one
  code path (decision e). This is a **body** reference → `422` (the transaction
  resource is fine; the body is unprocessable), NOT 404.
- **Expected**: both `422`, both body `{"detail":"CATEGORY_NOT_FOUND"}`
  (**string** code, not array), `diff` produces no output.
- **curl**:
```bash
RAND=$(uuidgen | tr 'A-F' 'a-f')
curl -s -w '\n%{http_code}\n' -X POST $BASE/transactions -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' \
  -d "{\"amount_minor\":100,\"kind\":\"expense\",\"occurred_at\":\"2026-03-21\",\"category_id\":\"$B_EXP\"}" \
  > /tmp/tx_cat_foreign.txt
curl -s -w '\n%{http_code}\n' -X POST $BASE/transactions -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' \
  -d "{\"amount_minor\":100,\"kind\":\"expense\",\"occurred_at\":\"2026-03-21\",\"category_id\":\"$RAND\"}" \
  > /tmp/tx_cat_missing.txt
cat /tmp/tx_cat_foreign.txt        # {"detail":"CATEGORY_NOT_FOUND"} then 422
diff /tmp/tx_cat_foreign.txt /tmp/tx_cat_missing.txt && echo "BYTE-IDENTICAL: PASS"
```
- **Expected**: `diff` empty. Any difference → ❌ (category existence oracle leak).
- **Status**: ✅ pass

### TC-10: POST archived (own, visible) category → 422 `CATEGORY_ARCHIVED`
- **Depends on**: PC-4 (A_ARCH is A's archived category).
- **What**: an archived category is a retired bucket; new spend may not land in
  it (decision e). Loaded visible first, so this is distinct from
  `CATEGORY_NOT_FOUND` (a *foreign* archived category would be `CATEGORY_NOT_FOUND`
  — existence stays secret; A_ARCH is A's OWN, so it is visible → `CATEGORY_ARCHIVED`).
- **Expected**: `422`, body `{"detail":"CATEGORY_ARCHIVED"}` (string code).
- **curl**:
```bash
curl -s -w '\n%{http_code}\n' -X POST $BASE/transactions -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' \
  -d "{\"amount_minor\":100,\"kind\":\"expense\",\"occurred_at\":\"2026-03-22\",\"category_id\":\"$A_ARCH\"}"
#   422, {"detail":"CATEGORY_ARCHIVED"}
```
- **Status**: ✅ pass

### TC-11: PATCH null clears `category_id`/`note`; omitted preserves `amount_minor`/`kind`
- **Depends on**: PC-4. Chained (create then patch). Pins the omitted-vs-explicit-
  null distinction on the wire (`model_fields_set`, decision e/i).
- **Steps**:
  1. Create a tx with `category_id=A_EXP`, `note="keep?"`, `amount_minor=900`,
     `kind=expense`.
  2. PATCH `{"category_id":null,"note":null}` **only** (amount/kind omitted).
  3. Expect `200`; `category_id → null`, `note → null`, `amount_minor` still
     `900`, `kind` still `expense` (untouched — omitted preserves).
- **curl**:
```bash
CID=$(curl -s -X POST $BASE/transactions -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' \
  -d "{\"amount_minor\":900,\"kind\":\"expense\",\"category_id\":\"$A_EXP\",\"occurred_at\":\"2026-03-23\",\"note\":\"keep?\"}" \
  | jq -r '.id')
curl -s -X PATCH $BASE/transactions/$CID -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' -d '{"category_id":null,"note":null}' \
  | jq '{category_id, note, amount_minor, kind}'
#   expect {"category_id":null,"note":null,"amount_minor":900,"kind":"expense"}
```
- **Status**: ✅ pass

### TC-12: PATCH explicit null on NOT-NULL fields → `*_REQUIRED` 422 (string codes)
- **Depends on**: PC-4. Chained (reuse a fresh tx).
- **What**: `amount_minor`/`kind`/`occurred_at` are NOT-NULL columns; an explicit
  `null` in the field set is caught by the router guard (else a bare apply 500s) →
  custom **string-code** 422s (decision e; contrast with TC-5's Pydantic array).
- **Expected**: `{"amount_minor":null}` → `422 {"detail":"AMOUNT_REQUIRED"}`;
  `{"kind":null}` → `422 {"detail":"KIND_REQUIRED"}`; `{"occurred_at":null}` →
  `422 {"detail":"OCCURRED_AT_REQUIRED"}`.
- **curl**:
```bash
CID=$(curl -s -X POST $BASE/transactions -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' \
  -d '{"amount_minor":100,"kind":"expense","occurred_at":"2026-03-24"}' | jq -r '.id')
for F in '{"amount_minor":null}' '{"kind":null}' '{"occurred_at":null}'; do
  curl -s -w ' <- %{http_code}\n' -X PATCH $BASE/transactions/$CID \
    -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' -d "$F"
done
#   expect {"detail":"AMOUNT_REQUIRED"} 422 / {"detail":"KIND_REQUIRED"} 422 / {"detail":"OCCURRED_AT_REQUIRED"} 422
```
- **Status**: ✅ pass

### TC-13: PATCH amount-only on a tx whose category was archived AFTER the fact → 200; PATCH repoint to foreign category → 422
- **Depends on**: PC-4. Chained. Pins the **PATCH category-revalidation trap**
  (decision e / Risks): category is validated **only when `category_id` is in the
  field set**.
- **Steps (a)**: create tx on `A_EXP`; archive `A_EXP`; PATCH `{"amount_minor":
  111}` only → **200** (category NOT revalidated — it is absent from the field
  set, so an amount edit of a now-archived-category tx succeeds).
- **Steps (b)**: on a fresh tx, PATCH `{"category_id":"<B_EXP>"}` (a foreign id) →
  `422 {"detail":"CATEGORY_NOT_FOUND"}` (write authz on the update path).
- **curl**:
```bash
# (a) archive-after-the-fact amount edit
TMPCAT=$(mkcat "$TOKEN_A" "qa-tx-archlater-$RUN" expense)
CID=$(curl -s -X POST $BASE/transactions -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' \
  -d "{\"amount_minor\":900,\"kind\":\"expense\",\"category_id\":\"$TMPCAT\",\"occurred_at\":\"2026-03-25\"}" | jq -r '.id')
curl -s -o /dev/null -X PATCH $BASE/categories/$TMPCAT -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' -d '{"archived":true}'
curl -s -w ' <- %{http_code}\n' -X PATCH $BASE/transactions/$CID \
  -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' -d '{"amount_minor":111}' \
  | jq -c '{amount_minor}'                                                 # 200, {"amount_minor":111}

# (b) repoint to a foreign category -> 422 CATEGORY_NOT_FOUND
CID2=$(curl -s -X POST $BASE/transactions -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' \
  -d '{"amount_minor":100,"kind":"expense","occurred_at":"2026-03-25"}' | jq -r '.id')
curl -s -w ' <- %{http_code}\n' -X PATCH $BASE/transactions/$CID2 \
  -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' \
  -d "{\"category_id\":\"$B_EXP\"}"                                        # {"detail":"CATEGORY_NOT_FOUND"} 422
```
- **Status**: ✅ pass

### TC-14: PATCH cross-user tx id AND random uuid → both 404 `TRANSACTION_NOT_FOUND`, BYTE-IDENTICAL
- **Depends on**: PC-4. **Headline security check (no-oracle).** The path id is
  loaded via a `user_id = me` scoped query, so a foreign id and a missing id both
  match nothing → same code path (decision a / Risks).
- **Steps**: create a tx as **A** (`A_TX`); as **B**, PATCH `A_TX` → 404; as **B**,
  PATCH a random UUID → 404; diff the raw bodies.
- **Expected**: both `404`, both `{"detail":"TRANSACTION_NOT_FOUND"}`, `diff` empty.
- **curl**:
```bash
A_TX=$(curl -s -X POST $BASE/transactions -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' \
  -d '{"amount_minor":100,"kind":"expense","occurred_at":"2026-03-26"}' | jq -r '.id')
RAND=$(uuidgen | tr 'A-F' 'a-f')
curl -s -w '\n%{http_code}\n' -X PATCH $BASE/transactions/$A_TX \
  -H "Authorization: Bearer $TOKEN_B" -H 'Content-Type: application/json' -d '{"amount_minor":1}' \
  > /tmp/tx_patch_crossuser.txt
curl -s -w '\n%{http_code}\n' -X PATCH $BASE/transactions/$RAND \
  -H "Authorization: Bearer $TOKEN_B" -H 'Content-Type: application/json' -d '{"amount_minor":1}' \
  > /tmp/tx_patch_missing.txt
cat /tmp/tx_patch_crossuser.txt      # {"detail":"TRANSACTION_NOT_FOUND"} then 404
diff /tmp/tx_patch_crossuser.txt /tmp/tx_patch_missing.txt && echo "BYTE-IDENTICAL: PASS"
```
- **Status**: ✅ pass

### TC-15: DELETE → 204 + row actually gone; repeat delete → 404; cross-user → 404 byte-identical
- **Depends on**: PC-4. Chained. Pins real DELETE (decision a) + delete no-oracle.
- **Steps**:
  1. A creates `D_TX`; A DELETE `D_TX` → `204`, **empty body**.
  2. Re-list → `D_TX` absent; DB confirms the row is gone (real delete).
  3. A DELETE `D_TX` again (now missing) → `404 TRANSACTION_NOT_FOUND`.
  4. A creates `D_TX2`; **B** DELETE `D_TX2` (cross-user) → `404`; diff vs the
     repeat-delete-missing body → byte-identical.
- **curl + DB check**:
```bash
D_TX=$(curl -s -X POST $BASE/transactions -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' \
  -d '{"amount_minor":100,"kind":"expense","occurred_at":"2026-03-27"}' | jq -r '.id')
curl -s -o /dev/null -w 'delete %{http_code}\n' -X DELETE $BASE/transactions/$D_TX \
  -H "Authorization: Bearer $TOKEN_A"                                     # 204
psql_q "SELECT count(*) FROM transactions WHERE id='$D_TX'"              # 0 (row gone)
curl -s $BASE/transactions -H "Authorization: Bearer $TOKEN_A" \
  | jq --arg id "$D_TX" '[.items[] | select(.id==$id)] | length'         # 0 (absent from list)

# repeat delete (missing) -> 404
curl -s -w '\n%{http_code}\n' -X DELETE $BASE/transactions/$D_TX \
  -H "Authorization: Bearer $TOKEN_A" > /tmp/tx_del_missing.txt
cat /tmp/tx_del_missing.txt                                              # {"detail":"TRANSACTION_NOT_FOUND"} 404

# cross-user delete -> 404, byte-identical to missing
D_TX2=$(curl -s -X POST $BASE/transactions -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' \
  -d '{"amount_minor":100,"kind":"expense","occurred_at":"2026-03-27"}' | jq -r '.id')
curl -s -w '\n%{http_code}\n' -X DELETE $BASE/transactions/$D_TX2 \
  -H "Authorization: Bearer $TOKEN_B" > /tmp/tx_del_crossuser.txt
diff /tmp/tx_del_missing.txt /tmp/tx_del_crossuser.txt && echo "BYTE-IDENTICAL: PASS"
```
- **Status**: ✅ pass

### TC-16: GET list — envelope `{items,total}` + ordering `occurred_at DESC`
- **Depends on**: PC-3. Uses a **fresh isolated user L** so counts/order are
  deterministic (A's rows accumulate across TCs).
- **Setup**: register+login L; create three tx at dates 2026-04-01, 2026-04-03,
  2026-04-02.
- **Expected**: `200`; body is `{items:[...], total:3}`; `items` ordered
  `occurred_at DESC` → `[04-03, 04-02, 04-01]`; `total == 3`.
- **curl**:
```bash
export EMAIL_L="qa_tx_l_${RUN}@x.com"
curl -s -o /dev/null -X POST $BASE/auth/register -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL_L\",\"password\":\"$PW\"}"
export TOKEN_L=$(curl -s -X POST $BASE/auth/login --data "username=$EMAIL_L&password=$PW" | jq -r '.access_token')
for D in 2026-04-01 2026-04-03 2026-04-02; do
  curl -s -o /dev/null -X POST $BASE/transactions -H "Authorization: Bearer $TOKEN_L" \
    -H 'Content-Type: application/json' \
    -d "{\"amount_minor\":100,\"kind\":\"expense\",\"occurred_at\":\"$D\"}"
done
curl -s $BASE/transactions -H "Authorization: Bearer $TOKEN_L" \
  | jq '{total, keys:(keys|sort), order:[.items[].occurred_at]}'
#   expect {"total":3,"keys":["items","total"],"order":["2026-04-03","2026-04-02","2026-04-01"]}
```
- **Status**: ✅ pass

### TC-17: GET list filters — from/to inclusive bounds, category_id, kind
- **Depends on**: TC-16 (user L). Adds a categorized income tx to exercise filters.
- **Setup**: L creates an own category `L_CAT` and an **income** tx on it at
  2026-04-02.
- **Expected**:
  - `?from=2026-04-02&to=2026-04-02` → only the 04-02 rows (**inclusive** both
    bounds; the boundary dates are included, decision l).
  - `?category_id=<L_CAT>` → only the tx on L_CAT.
  - `?kind=income` → only the income tx.
- **curl**:
```bash
L_CAT=$(mkcat "$TOKEN_L" "qa-tx-lcat-$RUN" income)
curl -s -o /dev/null -X POST $BASE/transactions -H "Authorization: Bearer $TOKEN_L" \
  -H 'Content-Type: application/json' \
  -d "{\"amount_minor\":5000,\"kind\":\"income\",\"category_id\":\"$L_CAT\",\"occurred_at\":\"2026-04-02\"}"

curl -s "$BASE/transactions?from=2026-04-02&to=2026-04-02" -H "Authorization: Bearer $TOKEN_L" \
  | jq '{total, dates:[.items[].occurred_at]}'          # all == 2026-04-02 (inclusive bounds)
curl -s "$BASE/transactions?category_id=$L_CAT" -H "Authorization: Bearer $TOKEN_L" \
  | jq '{total, cats:[.items[].category_id]|unique}'    # only L_CAT
curl -s "$BASE/transactions?kind=income" -H "Authorization: Bearer $TOKEN_L" \
  | jq '{total, kinds:[.items[].kind]|unique}'          # ["income"]
```
- **Status**: ✅ pass

### TC-18: GET list — foreign category_id filter → empty 200 (NOT an error); from>to → empty 200
- **Depends on**: TC-16 (user L). Pins decision l: a READ filter never does an
  existence check and never validates the range — it just filters.
- **Expected**:
  - `?category_id=<A_EXP>` (a foreign category, or any random uuid) → `200`,
    `{items:[], total:0}` — **not** a 422/404. An unknown/foreign filter simply
    matches no rows.
  - `?from=2026-12-31&to=2026-01-01` (from > to) → `200`, `{items:[], total:0}`
    (the WHERE naturally yields nothing — decided: no `INVALID_PERIOD` error).
- **curl**:
```bash
curl -s -o /dev/null -w 'foreign-cat-filter %{http_code}\n' \
  "$BASE/transactions?category_id=$A_EXP" -H "Authorization: Bearer $TOKEN_L"   # 200
curl -s "$BASE/transactions?category_id=$A_EXP" -H "Authorization: Bearer $TOKEN_L" \
  | jq '{total, n:(.items|length)}'                                             # {"total":0,"n":0}
curl -s -o /dev/null -w 'from>to %{http_code}\n' \
  "$BASE/transactions?from=2026-12-31&to=2026-01-01" -H "Authorization: Bearer $TOKEN_L"  # 200
curl -s "$BASE/transactions?from=2026-12-31&to=2026-01-01" -H "Authorization: Bearer $TOKEN_L" \
  | jq '.total'                                                                 # 0
```
- **Status**: ✅ pass

### TC-19: GET list pagination — limit/offset slice with stable total; limit=201 → 422; offset=-1 → 422
- **Depends on**: TC-16 (user L has 4 rows now: 3 expense + 1 income).
- **Expected**:
  - `?limit=1&offset=1` → `items` has exactly 1 row (the 2nd in DESC order),
    `total` == the full unpaged count (stable, not the page size).
  - `?limit=201` → `422` (`le=200`, Pydantic array).
  - `?offset=-1` → `422` (`ge=0`, Pydantic array).
- **curl**:
```bash
FULL=$(curl -s $BASE/transactions -H "Authorization: Bearer $TOKEN_L" | jq '.total')
curl -s "$BASE/transactions?limit=1&offset=1" -H "Authorization: Bearer $TOKEN_L" \
  | jq --argjson full "$FULL" '{page_items:(.items|length), total, stable:(.total==$full)}'
#   expect {"page_items":1,"total":<FULL>,"stable":true}
curl -s -o /dev/null -w 'limit=201 %{http_code}\n' \
  "$BASE/transactions?limit=201" -H "Authorization: Bearer $TOKEN_L"      # 422
curl -s -o /dev/null -w 'offset=-1 %{http_code}\n' \
  "$BASE/transactions?offset=-1" -H "Authorization: Bearer $TOKEN_L"      # 422
```
- **Status**: ✅ pass

### TC-20: GET /summary — refund scenario, uncategorized bucket, signed negative net, other-month exclusion
- **Depends on**: PC-3. Uses a **fresh isolated user S** so the month totals are
  deterministic. Exercises decision f/j (refund = income tx on an expense
  category, counted as income; uncategorized `NULL` bucket; other-month excluded).
- **Setup (all for user S, own expense category `S_EXP`)** — month **2026-05**:
  | tx | kind | amount | category | occurred_at |
  |---|---|---|---|---|
  | t1 | expense | 10000 | S_EXP | 2026-05-10 |
  | t2 | expense | 5000 | *null* (uncategorized) | 2026-05-15 |
  | t3 | **income (refund)** | 3000 | S_EXP | 2026-05-20 |
  | t4 | expense | 99999 | S_EXP | 2026-06-01 (OTHER month) |
- **Expected** for `?month=2026-05`:
  - `income_minor == 3000` (the refund counted as income, **not** netted into the
    category's expense).
  - `expense_minor == 15000` (10000 + 5000; t4 excluded — other month).
  - `net_minor == -12000` (**signed, negative**: income − expense).
  - `currency == "RUB"`.
  - `by_category` contains: an **expense** bucket for `S_EXP` (10000), an
    **income** bucket for the **same** `S_EXP` (3000, the refund), and a
    `category_id: null` **expense** bucket (5000, uncategorized).
- **curl**:
```bash
export EMAIL_S="qa_tx_s_${RUN}@x.com"
curl -s -o /dev/null -X POST $BASE/auth/register -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL_S\",\"password\":\"$PW\"}"
export TOKEN_S=$(curl -s -X POST $BASE/auth/login --data "username=$EMAIL_S&password=$PW" | jq -r '.access_token')
S_EXP=$(mkcat "$TOKEN_S" "qa-tx-sexp-$RUN" expense)
post_s() { curl -s -o /dev/null -X POST $BASE/transactions -H "Authorization: Bearer $TOKEN_S" \
  -H 'Content-Type: application/json' -d "$1"; }
post_s "{\"amount_minor\":10000,\"kind\":\"expense\",\"category_id\":\"$S_EXP\",\"occurred_at\":\"2026-05-10\"}"
post_s "{\"amount_minor\":5000,\"kind\":\"expense\",\"category_id\":null,\"occurred_at\":\"2026-05-15\"}"
post_s "{\"amount_minor\":3000,\"kind\":\"income\",\"category_id\":\"$S_EXP\",\"occurred_at\":\"2026-05-20\"}"
post_s "{\"amount_minor\":99999,\"kind\":\"expense\",\"category_id\":\"$S_EXP\",\"occurred_at\":\"2026-06-01\"}"

SUM=$(curl -s "$BASE/transactions/summary?month=2026-05" -H "Authorization: Bearer $TOKEN_S")
echo "$SUM" | jq '{month, currency, income_minor, expense_minor, net_minor}'
#   expect {"month":"2026-05","currency":"RUB","income_minor":3000,"expense_minor":15000,"net_minor":-12000}
echo "$SUM" | jq --arg c "$S_EXP" '{
  exp_bucket:  (.by_category[] | select(.category_id==$c and .kind=="expense") | .total_minor),
  inc_bucket:  (.by_category[] | select(.category_id==$c and .kind=="income")  | .total_minor),
  uncat_bucket:(.by_category[] | select(.category_id==null and .kind=="expense")| .total_minor)
}'
#   expect {"exp_bucket":10000,"inc_bucket":3000,"uncat_bucket":5000}
```
- **Status**: ✅ pass

### TC-21: GET /summary — empty month → zeros + `by_category []` (200, never 404) + RUB fallback
- **Depends on**: register a **fresh user E** with zero transactions.
- **What**: an aggregate for a month with no data is a valid answer, not a missing
  resource (decision j). The `currency` is the base currency; note the plan's
  read-only fallback (AM-1, pytest-owned): even a profile-less user gets
  `currency == "RUB"` from the summary GET **without** the GET creating a profile
  row. My check confirms the wire value; the "no profile row written" assertion is
  pytest test 15 (I do not duplicate it).
- **Expected**: `200`; `income_minor == expense_minor == net_minor == 0`;
  `by_category == []`; `currency == "RUB"`.
- **curl**:
```bash
export EMAIL_E="qa_tx_e_${RUN}@x.com"
curl -s -o /dev/null -X POST $BASE/auth/register -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL_E\",\"password\":\"$PW\"}"
export TOKEN_E=$(curl -s -X POST $BASE/auth/login --data "username=$EMAIL_E&password=$PW" | jq -r '.access_token')
curl -s -o /dev/null -w 'empty-summary %{http_code}\n' \
  "$BASE/transactions/summary?month=2026-05" -H "Authorization: Bearer $TOKEN_E"   # 200 (never 404)
curl -s "$BASE/transactions/summary?month=2026-05" -H "Authorization: Bearer $TOKEN_E" \
  | jq '{income_minor, expense_minor, net_minor, currency, by_category}'
#   expect {"income_minor":0,"expense_minor":0,"net_minor":0,"currency":"RUB","by_category":[]}
```
- **Status**: ✅ pass

### TC-22: GET /summary — malformed month → 422 Pydantic array; /summary reachable (not swallowed)
- **Depends on**: TOKEN_A.
- **What**: `month` is `Query(pattern=r"^\d{4}-(0[1-9]|1[0-2])$")` → a malformed
  value is a **standard Pydantic 422** (array, no custom code — decision j). Also
  confirm `/summary` is reachable and NOT swallowed by any `/{transaction_id}`
  path route (route-ordering Risk — a valid month returns 200, proving the literal
  segment resolves, not a UUID-param 422).
- **Expected**: `2026-13`, `2026-1`, `garbage` each → `422` with `detail` array; a
  well-formed `2026-05` → `200` (reachable).
- **curl**:
```bash
for M in 2026-13 2026-1 garbage 2026-00; do
  curl -s -o /dev/null -w "month=$M -> %{http_code}\n" \
    "$BASE/transactions/summary?month=$M" -H "Authorization: Bearer $TOKEN_A"
done                                                                     # each -> 422
curl -s "$BASE/transactions/summary?month=2026-13" -H "Authorization: Bearer $TOKEN_A" \
  | jq 'if (.detail|type)=="array" then "pydantic-array-OK" else {LEAK:.} end'   # "pydantic-array-OK"
curl -s -o /dev/null -w 'reachable %{http_code}\n' \
  "$BASE/transactions/summary?month=2026-05" -H "Authorization: Bearer $TOKEN_A"  # 200 (not swallowed)
```
- **Status**: ✅ pass

### TC-23: OpenAPI contract exposes the five /transactions operations
- **Runs against**: both the live server `/openapi.json` and the committed
  `apps/api/openapi.json` (TC-24 proves they agree).
- **Expected**: `/transactions` has `get` + `post`; `/transactions/summary` has
  `get`; `/transactions/{transaction_id}` has `patch` + `delete`. (Path param
  pinned `transaction_id`, per plan skeleton.)
- **curl / jq**:
```bash
curl -s $BASE/openapi.json | jq '.paths | keys | map(select(startswith("/transactions")))'
#   ["/transactions","/transactions/summary","/transactions/{transaction_id}"]
curl -s $BASE/openapi.json | jq '.paths["/transactions"] | keys'                     # ["get","post"]
curl -s $BASE/openapi.json | jq '.paths["/transactions/summary"] | keys'             # ["get"]
curl -s $BASE/openapi.json | jq '.paths["/transactions/{transaction_id}"] | keys'    # ["delete","patch"]

# Committed artifact must show the same new paths:
jq '.paths | keys | map(select(startswith("/transactions")))' \
  /Users/nikitazaretski/work/budget/apps/api/openapi.json
```
- **Status**: ✅ pass

### TC-24: Contract artifacts in-sync + committed together; TransactionKind is a SEPARATE enum component; honest 422 anyOf union
- **What**: (a) committed `openapi.json` matches the current app (drift test);
  (b) committed `packages/api-client/src/generated/schema.d.ts` matches a fresh
  regeneration; (c) both landed in the **same commit** (standing rule); (d)
  **`TransactionKind` is its own schema component, distinct from `CategoryKind`**
  (decision c — the enums must NOT be merged; a merge is a breaking contract move
  when stage-5 adds a third tx-only value); (e) **AM-5 (grooming-review §3 R1) —
  the POST `/transactions` and PATCH `/transactions/{transaction_id}` 422 response
  content schema is an `anyOf` union of `$ref`s to BOTH `TransactionError` AND
  `HTTPValidationError`** (the generated 422 type is honest about both runtime
  arms: the custom string-code business rejection AND the Pydantic array). Both
  `$ref`s must resolve to real, **unmangled** components (no
  `budget_api__…__HTTPValidationError` name mangling — R1 mechanics).
- **Commands**:
```bash
cd /Users/nikitazaretski/work/budget

# (a) API-side drift test — red if openapi.json is stale:
TEST_DATABASE_URL='postgresql+asyncpg://budget:budget@localhost:5443/budget_test' \
  pnpm --filter @budget/api test -- tests/test_openapi_export.py::TestOpenApiExport::test_committed_schema_matches_current_app

# (b) Client-side drift test — committed schema.d.ts byte-identical to regen:
pnpm --filter @budget/api-client test -- src/drift.test.ts

# (c) Both artifacts in the SAME commit (deferred to the actual commit if nothing
#     is committed yet at /test — degrade to a working-tree "modified together"
#     check, mirroring 1.3 TC-21):
git log --oneline -1 -- apps/api/openapi.json
git log --oneline -1 -- packages/api-client/src/generated/schema.d.ts
git show --stat "$(git log -1 --format=%H -- apps/api/openapi.json)" \
  -- apps/api/openapi.json packages/api-client/src/generated/schema.d.ts
#   (fallback: git status --porcelain shows BOTH files ' M' together)

# (d) TransactionKind is a distinct component from CategoryKind:
curl -s $BASE/openapi.json | jq '.components.schemas | has("TransactionKind") and has("CategoryKind")'  # true
curl -s $BASE/openapi.json | jq '.components.schemas.TransactionKind.enum'   # ["expense","income"]
curl -s $BASE/openapi.json | jq '.components.schemas.CategoryKind.enum'      # ["expense","income"]
grep -c 'TransactionKind' packages/api-client/src/generated/schema.d.ts     # >= 1 (separate generated type)

# (e) AM-5 — POST/PATCH 422 is an anyOf union of TransactionError AND HTTPValidationError.
#     Run against the LIVE /openapi.json AND the committed apps/api/openapi.json (must agree).
POST422='.paths["/transactions"].post.responses["422"].content["application/json"].schema.anyOf | map(."$ref")'
PATCH422='.paths["/transactions/{transaction_id}"].patch.responses["422"].content["application/json"].schema.anyOf | map(."$ref")'
curl -s $BASE/openapi.json | jq "$POST422"
curl -s $BASE/openapi.json | jq "$PATCH422"
#   each -> ["#/components/schemas/TransactionError","#/components/schemas/HTTPValidationError"]
#   (order not load-bearing; BOTH refs must be present)
jq "$POST422"  /Users/nikitazaretski/work/budget/apps/api/openapi.json     # same two $refs (committed artifact)
jq "$PATCH422" /Users/nikitazaretski/work/budget/apps/api/openapi.json     # same two $refs
# both components exist and are UNMANGLED (no budget_api__…__ prefix):
curl -s $BASE/openapi.json | jq '.components.schemas | has("TransactionError") and has("HTTPValidationError")'   # true
curl -s $BASE/openapi.json | jq '[.components.schemas | keys[] | select(test("__"))]'                           # [] (no mangled names)
```
- **Expected**: both drift tests green; the two `git log` SHAs identical (or
  degraded working-tree check shows both modified together); `TransactionKind` and
  `CategoryKind` are **both present as separate components**; the POST and PATCH
  422 `anyOf` each lists **both** `TransactionError` and `HTTPValidationError`
  `$ref`s (live == committed), both components present and unmangled. Any stale
  artifact, split commit, a single merged kind enum, a 422 that names only one arm
  (the type would lie about the other), or a mangled component name → ❌.
- **Status**: ✅ pass

### TC-25: Categories regression smoke (post-extraction refactor)
- **What**: after `visible_categories_clause` / `load_visible_category` were
  extracted to `category_access.py` and `categories.py` refactored onto them,
  confirm no behavior change on the two paths those helpers back. **The pytest
  `test_categories.py` suite is the main guard (TC-Z1); this is a smoke.**
- **Expected**:
  - GET `/categories` (as A) still merges the 18 system seeds with A's own rows
    (list-merge → `visible_categories_clause`).
  - PATCH a cross-user category id (as B) still → `404 CATEGORY_NOT_FOUND`
    (`load_visible_category` no-oracle preserved).
- **curl**:
```bash
curl -s $BASE/categories -H "Authorization: Bearer $TOKEN_A" \
  | jq '[.[] | select(.is_system==true)] | length'                       # 18 (merge intact)
# cross-user category PATCH still 404 (A_EXP belongs to A; B cannot see it):
curl -s -w '\n%{http_code}\n' -X PATCH $BASE/categories/$A_EXP \
  -H "Authorization: Bearer $TOKEN_B" -H 'Content-Type: application/json' -d '{"name":"hax"}'
#   {"detail":"CATEGORY_NOT_FOUND"} 404
```
- **Status**: ✅ pass

### TC-Z1: full pytest suite green (Section A verification)
- **What**: run backend's pytest suite (incl. `tests/test_transactions.py` tests
  1–16 AND the unchanged `tests/test_categories.py` that guards the extraction
  refactor) against the test PG on 5443.
- **Command**:
```bash
cd /Users/nikitazaretski/work/budget
TEST_DATABASE_URL='postgresql+asyncpg://budget:budget@localhost:5443/budget_test' \
  pnpm --filter @budget/api test
#   (or: cd apps/api && TEST_DATABASE_URL=…5443/budget_test uv run pytest)
```
- **Expected**: all tests pass. If any fail → capture output, **do NOT fix
  backend code**, escalate to senior-lead.
- **Status**: ✅ pass

---

## Division of labor — what I deliberately do NOT re-check (pytest pins it)

Pointing at **plan.md's Test plan** (`tests/test_transactions.py`, tests 1–16):

- **Forced-ownership internals + serialize shape** (test 1): pytest asserts the
  stored `user_id` and the absent DTO `user_id`. TC-2 adds the live-wire +
  psql cross-check; I do not re-assert the serializer field list.
- **Self-heal create-branch** (test 2 — delete profile, POST recreates it):
  pytest-owned. TC-4/TC-2 exercise the currency stamp on the wire; I do not
  delete/recreate the profiles row via curl.
- **Summary correctness math** (test 14): the definitive refund/uncategorized/
  range test is pytest. TC-20 is a **live-wire** re-verification with concrete
  numbers (real HTTP aggregate over real rows) — documented overlap: the summary
  is the core aggregate and the first of its kind, worth a live pin of the exact
  wire numbers, not just an in-process assert.
- **`model_fields_set` omitted-vs-null mechanics** (test 8): pytest owns the
  branch logic; TC-11 verifies only the observable wire effect.
- **`*_REQUIRED` guard internals** (test 9): pytest pins the bare-apply-500
  prevention; TC-12 verifies the live string-code envelopes.
- **Cross-user category authz on write** (tests 3, 10): pytest owns the pinned
  authz; TC-9/TC-13b add the byte-identical live bodies.
- **No-oracle byte-identity for tx 404** (tests 7, 11): pytest pins identity;
  TC-14/TC-15 diff the raw wire bytes live.
- **Zero-amount deferred-policy pin** (test 6): pytest keeps the `ge=1`
  regression guard (goes red in CI if loosened); TC-5 is the **wire-shape**
  contrast (Pydantic ARRAY vs our string codes) — a different concern, so both.
- **kind CHECK-constraint enforcement**: 1.2 `test_core_model.py`; TC-6 covers
  only the Pydantic enum-value rejection (422 array), a distinct layer.
- **Model↔migration byte-identity** (`kind IN ('expense','income')` rebuilt from
  `TransactionKind`): senior diff gate + `alembic check`, not a curl concern.
- **Categories extraction non-regression**: existing `tests/test_categories.py`
  (cross-user/missing 404, system 403, list merge) is the guard; TC-25 is a
  smoke only, not a re-implementation.
- **get-or-create PK race** (AM-2): accepted in writing, out of QA scope — NOT
  flagged.

**What I own (the pure-Pydantic/wire rejections pytest deliberately excludes,
per plan.md "NOT writing" list + the 1.3 split):** `note` > 500 (TC-8), invalid
`kind` enum value (TC-6), malformed `occurred_at`/`from`/`to`/`month` (TC-7,
TC-22), `amount_minor` 0/negative wire shape (TC-5), `limit`/`offset` out of
range (TC-19), plus the live error-envelope contrasts (string-code vs Pydantic
array), the byte-identical no-oracle bodies (TC-9/14/15), the AM-4 extra-field
wire decision (TC-4), and the contract-artifact drift/same-commit/separate-enum
gates (TC-23/24).

---

## Summary gates (all must be green before merge)

| Gate | TCs | Meaning |
|---|---|---|
| Auth wall | TC-1 | all five routes 401 without a token (status-only) |
| POST happy + ownership | TC-2 | 201, currency RUB stamped, no user_id leak, DB owner forced |
| POST uncategorized | TC-3 | null category → 201 |
| AM-4 extra-field ignore | TC-4 | body `currency:"USD"` → 201, currency RUB |
| POST Pydantic-layer 422 | TC-5, TC-6, TC-7, TC-8 | amount ge=1 array, bad kind, malformed date (future date → 201, AM-7), note>500 — all ARRAY 422 |
| POST category-ref no-oracle | TC-9 | foreign vs missing → byte-identical 422 CATEGORY_NOT_FOUND |
| POST archived category | TC-10 | own archived → 422 CATEGORY_ARCHIVED |
| PATCH null/omit + required | TC-11, TC-12 | null clears cat/note, omit preserves; null on NOT-NULL → *_REQUIRED |
| PATCH revalidation trap | TC-13 | amount-only on archived-later cat → 200; repoint foreign → 422 |
| Tx path no-oracle | TC-14, TC-15 | PATCH/DELETE cross-user vs missing → byte-identical 404 |
| DELETE real + gone | TC-15 | 204, row deleted, repeat → 404 |
| List envelope/order/filter/page | TC-16, TC-17, TC-18, TC-19 | {items,total}, DESC, inclusive/filter, empty-not-error, limit/offset |
| Summary correctness (live) | TC-20 | refund income bucket, uncategorized null bucket, signed −net, other-month excluded |
| Summary empty + malformed | TC-21, TC-22 | zeros not 404, RUB fallback; bad month → 422 array; /summary reachable |
| Contract artifacts | TC-23, TC-24 | 5 ops in openapi; in-sync + same-commit; TransactionKind separate component; POST/PATCH 422 anyOf[TransactionError, HTTPValidationError] (AM-5) |
| Categories regression smoke | TC-25 | list merge + cross-user 404 intact after extraction |
| pytest suite | TC-Z1 | Section A green (tests 1–16 + unchanged test_categories.py) |

**Overall status**: ✅ READY FOR REVIEW (executed at /test 2026-07-24 on
:8010 / live DB :5443/`budget`, pytest DB :5443/`budget_test`).

### Final report (filled at /test — 2026-07-24)
- Total: 4 preconditions (PC-1…PC-4) + 25 TCs (TC-1…TC-25) + TC-Z1 = **30 checks**
  (unchanged: the AM-5 and AM-7 deltas extended existing TC-24 and TC-7 in place,
  adding no new TC).
- **Passed: 30** — PC-1…PC-4 (all preconditions met: health 200
  `{"status":"ok","database":"ok"}`, psql `SELECT 1`=1, regA/regB 201, tokens +
  A_ID captured, 5 category ids UUIDs, A_ARCH archived, seed count 18); TC-1…TC-25
  all ✅; TC-Z1 ✅ (64/64 pytest green incl. test_transactions.py 16 + unchanged
  test_categories.py 17).
- **Failed: 0.**
- **Blocked: 0.**

Selected wire evidence (all matched expected):
- TC-1: POST/GETlist/SUMMARY/PATCH/DELETE all → 401 (status-only).
- TC-2: `currency"RUB"`, `has_user_id false`, keys = [amount_minor, category_id,
  created_at, currency, id, kind, note, occurred_at]; DB forced-owner `t`.
- TC-4 (AM-4): body `currency:"USD"` → 201, response `currency=="RUB"`.
- TC-5: amount 0 and -1 → 422, `detail` array (`pydantic-array-OK`).
- TC-7 (AM-7): malformed dates → 422 array; `2030-01-01` → **201** (future allowed).
- TC-8: note 501 → 422; exactly-500 → 201 (len 500); whitespace-only → 201 note null.
- TC-9: foreign vs random-uuid category → both 422 `CATEGORY_NOT_FOUND`, `diff` empty.
- TC-12: `AMOUNT_REQUIRED` / `KIND_REQUIRED` / `OCCURRED_AT_REQUIRED`, all 422 (string).
- TC-14: PATCH cross-user vs missing → both 404 `TRANSACTION_NOT_FOUND`, `diff` empty.
- TC-15: DELETE 204, DB row count 0, absent from list, repeat/cross-user 404 byte-identical.
- TC-20: income 3000 / expense 15000 / net -12000; buckets exp 10000, inc 3000, uncat 5000.
- TC-21: empty month → 200, zeros, `by_category []`, `currency"RUB"` (RUB fallback).
- TC-22 (AM-6/U3): `2026-13`, `2026-1`, `garbage`, `2026-00` → each 422 array; `2026-05` → 200.
- TC-24 (AM-5): live == committed for POST and PATCH 422 `anyOf` =
  [`TransactionError`, `HTTPValidationError`]; both components present, no mangled
  (`__`) names; `TransactionKind`.enum and `CategoryKind`.enum both `["expense","income"]`
  as separate components. Drift: TC-24a pytest green, TC-24b vitest green. Same-commit
  (TC-24c) degraded per U4 — 1.4 artifacts uncommitted (last commit for both = 1.3
  `044cd2b`); `git status --porcelain` shows both files ` M` (modified together) → pass.

Environment deviations:
- Env metadata reported "Is directory a git repo: No", but `git rev-parse` confirms
  it IS a repo. TC-24c was executed as the real working-tree degraded check (both
  artifacts ` M` together), not skipped. No functional impact.
- No other deviations. `alembic upgrade head` was NOT needed — `transactions` table
  and 18 seeds already present in live `budget` DB. Server started by QA on :8010
  and stopped at end of run (env-only setup; no source/config edits).

---

## Rulings received (grooming-review §3 R2)

U1–U5 are **RULED** (grooming-review §3 R2). No open uncertainties remain.

- **U1 — /test BASE port / server ownership — RULED.** `8010` stands; **QA
  starts uvicorn** exactly as the preconditions are written (mirror 1.3). If the
  PM supplies a running server, QA adjusts `BASE` only — no checklist change.
- **U2 — 501-spaces → 201 curl — RULED: correctly omitted.** Not added; strip-
  before-cap is a validator-internal ordering whose two observable behaviors are
  already pinned in TC-8 (whitespace-only → null; >500 non-space → 422). A third
  curl would be vacuous per the test policy.
- **U3 — `2026-00` month / regex-vs-parse — RULED BINDING (AM-6).** The
  `Query(pattern=r"^\d{4}-(0[1-9]|1[0-2])$")` regex validates at the
  Pydantic/Query layer **before** any `date()` construction; `2026-00`,
  `2026-13`, garbage → Pydantic array 422, **never** a 500. TC-22 stands exactly
  as written, `2026-00` included.
- **U4 — same-commit contract check — RULED: working-tree degradation accepted
  (mirror 1.3).** If no commit exists when QA runs, TC-24c degrades to the
  "both artifacts modified together" working-tree check; senior re-verifies the
  strict same-commit property at the final commit gate.
- **U5 — `/summary` route-ordering — RULED: non-finding today.** No
  `GET /{transaction_id}` exists (different methods don't collide); TC-22's
  reachability check is the live proof. The defensive declaration order stands
  and the trap is recorded against the decision-m future trigger.
