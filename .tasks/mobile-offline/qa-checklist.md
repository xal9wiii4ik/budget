# QA Checklist: mobile-offline B-1 — transaction-create idempotency via `client_id`

> **GROOMING ARTIFACT — EXECUTE AT /test. NOTHING BELOW HAS BEEN RUN.**
> B-1 is not implemented yet (it is sequenced AFTER the `recurring-and-limits`
> scope), so every TC is ⏸ **pending / EXECUTE-AT-/test**. The only thing I did at
> grooming time was read the code at HEAD (`routers/transactions.py`,
> `schemas/transaction.py`, `tests/test_transactions.py`, plan.md, architecture
> Decision 3). No request was made against any API.

**Scope of this file: B-1 only** (the backend subtask — schema field, column +
partial unique index, migration, create-path restructure, contract regen). It does
**not** cover B-2/M-x (outbox, persister, coordinator) — those get their own
checklist(s) from mobile-qa at their own /test.

## Split rule I applied (per plan.md §5)

pytest (backend-engineer, `tests/test_transaction_idempotency.py`) owns the
behavioural matrix: hit/miss semantics, first-write-wins, cross-user rows,
NULL-guard, merchant-map skip, archived-category-on-replay, concurrency + the
mocked IntegrityError arm. **I do not re-run any of that.**

My live layer owns exactly what the pytest suite cannot or deliberately does not
prove, and what the *mobile client* will actually hit on the wire:

1. **Pure-Pydantic 422s** — plan §2.1/§5 explicitly assign malformed `client_id`
   to QA-curl, no pytest (house split, same as the transactions router today).
2. **The DDL fact** — plan §5 "Not written, deliberately": no pytest asserts the
   column/index exist. The partial unique index is the invariant of B-1; it is
   proven live at the DDL level via raw psql (receipts TC-S1-3 precedent).
3. **The wire contract the generated client consumes** — the declared 200 arm,
   `client_id` present on `TransactionCreate` / absent from `TransactionRead`,
   live `openapi.json` == committed.
4. **Real-server concurrency** — separate OS processes over real uvicorn + a real
   asyncpg pool, not `ASGITransport` inside one event loop (pytest test 7's own
   honesty note says it is probabilistic).
5. **UUID canonicalization** (uppercase / urn / braces) — a real mobile risk that
   no pytest in the plan touches.
6. **Regression smoke** of the surrounding transactions API — the whole point of
   B-1's "byte-identical for callers without `client_id`" promise.

Where I deliberately overlap pytest (cross-user, replay-twice, concurrency), the
reason is stated in the TC. At each /test I also run the full pytest suite green
(TC-Z1) and I do **NOT** write or fix backend code — a failure is captured and
escalated to senior-lead.

---

## Preconditions (run once at B-1's /test, keep the shell)

### Environment (house standard — carried from 1.3/1.4 / receipts / currencies-goals / stats-advisor)
```bash
export BASE=http://localhost:8010                       # dev API (uvicorn, +10 convention)
export API=/Users/nikitazaretski/work/budget/apps/api
export ROOT=/Users/nikitazaretski/work/budget
# Live server DB (server reads apps/api/.env → 5443/budget):
psql_q() { PGPASSWORD=budget psql -h localhost -p 5443 -U budget -d budget -tAc "$1"; }
# Migration/DDL DB for the destructive alembic cycle (NOT the live budget DB):
export ADB='postgresql+asyncpg://budget:budget@localhost:5443/budget_test'
export TDB='postgresql://budget:budget@localhost:5443/budget_test'
```
> **5443 vs 5433 standing rule (carried from 1.2 onward):** committed compose maps
> `5433`; the live app + all QA psql/alembic target **5443**. Never edit
> `conftest.py` / `docker-compose.yml` / `.env` — env-only setup.

### PC-A — dev API up on 8010, live DB at head — STOP rule
```bash
curl -s -o /dev/null -w '%{http_code}\n' $BASE/health && curl -s $BASE/health   # 200 {"status":"ok","database":"ok"}
cd "$API" && uv run alembic current                                            # must be the B-1 revision, marked (head)
cd "$API" && uv run alembic check                                              # "No new upgrade operations detected."
```
- The B-1 migration number is assigned at implement time (plan §2.3/§7) — I assert
  "`current` == `heads`", not a hardcoded number.
- `alembic check` clean here is plan risk §9's partial-index-drift gate; a drift
  report is a **STOP** (never suppressed).
- Not 200 / not at head / drift → **STOP**, report to senior-lead.

### PC-B — two users + tokens + ids + categories
Form-encoded login (`username` = email), `@budgetqa.dev` emails, unique per run.
```bash
export RUN=$(date +%s); export PW="password123"
export EMAIL_A="qa-b1-a-${RUN}@budgetqa.dev"; export EMAIL_B="qa-b1-b-${RUN}@budgetqa.dev"
curl -s -o /dev/null -w 'regA %{http_code}\n' -X POST $BASE/auth/register -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL_A\",\"password\":\"$PW\"}"   # 201
curl -s -o /dev/null -w 'regB %{http_code}\n' -X POST $BASE/auth/register -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL_B\",\"password\":\"$PW\"}"   # 201
export TOKEN_A=$(curl -s -X POST $BASE/auth/login --data "username=$EMAIL_A&password=$PW" | jq -r '.access_token')
export TOKEN_B=$(curl -s -X POST $BASE/auth/login --data "username=$EMAIL_B&password=$PW" | jq -r '.access_token')
export A_ID=$(curl -s $BASE/users/me -H "Authorization: Bearer $TOKEN_A" | jq -r '.id')
export B_ID=$(curl -s $BASE/users/me -H "Authorization: Bearer $TOKEN_B" | jq -r '.id')
export A_EXP=$(curl -s -X POST $BASE/categories -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' -d '{"name":"qa-b1-exp","kind":"expense"}' | jq -r '.id')
export A_EXP2=$(curl -s -X POST $BASE/categories -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' -d '{"name":"qa-b1-exp2","kind":"expense"}' | jq -r '.id')
export B_EXP=$(curl -s -X POST $BASE/categories -H "Authorization: Bearer $TOKEN_B" -H 'Content-Type: application/json' -d '{"name":"qa-b1-bexp","kind":"expense"}' | jq -r '.id')
# helper: full transaction count for a token
cnt() { curl -s "$BASE/transactions?limit=200" -H "Authorization: Bearer $1" | jq -r '.total'; }
```
Both users start at **zero** transactions — every `total` below is absolute.
Default profile base is **RUB** (`models/profile.DEFAULT_BASE_CURRENCY`); every
body below is base-currency (no `currency` sent) so **no FX rate is needed** and
`base_amount_minor`/`base_currency` are expected `null`. STOP if any token/id empty.
`jq` may be absent on this host (it was for S1–S3 of receipts) — fall back to
`python3 -c` for JSON; assertions unchanged.

### PC-C — the shared payload + fresh keys
```bash
mkuuid() { uuidgen | tr 'A-F' 'a-f'; }
body() {  # $1 = client_id (or "-" for none), $2 = amount_minor
  if [ "$1" = "-" ]; then printf '{"amount_minor":%s,"kind":"expense","occurred_at":"2026-08-18","category_id":"%s","note":"qa-b1"}' "$2" "$A_EXP"
  else printf '{"amount_minor":%s,"kind":"expense","occurred_at":"2026-08-18","category_id":"%s","note":"qa-b1","client_id":"%s"}' "$2" "$A_EXP" "$1"; fi
}
post() { curl -s -w '\n%{http_code}\n' -X POST $BASE/transactions -H "Authorization: Bearer $1" -H 'Content-Type: application/json' -d "$2"; }
```

---

# Section B — curl test cases (QA-owned, run at B-1's /test)

### TC-B1-1: malformed `client_id` → 422, and **nothing is created**
- **Why curl**: plan §2.1 assigns pure-Pydantic rejection to QA-curl explicitly
  ("a malformed value is a plain 422 — QA-curl-owned per the house split, no pytest").
- **Method/Endpoint**: `POST /transactions`
- **Headers**: `Authorization: Bearer $TOKEN_A`, `Content-Type: application/json`
- **Expected**: every malformed form → **422** with an `HTTPValidationError` body whose
  `detail[0].loc == ["body","client_id"]` and `type` in the uuid-parsing family
  (`uuid_parsing` / `uuid_type`) — **not** the business `TransactionError` shape, and
  **not** a 500. `cnt` unchanged (0) after all of them.
- **curl**:
```bash
B4=$(cnt "$TOKEN_A")
for BAD in '"not-a-uuid"' '""' '"123"' '12345' 'true' '"550e8400-e29b-41d4-a716"' '"zzzzzzzz-e29b-41d4-a716-446655440000"' '[]'; do
  printf '%s -> ' "$BAD"
  curl -s -o /tmp/b1_bad.json -w '%{http_code}\n' -X POST $BASE/transactions \
    -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' \
    -d "{\"amount_minor\":1000,\"kind\":\"expense\",\"occurred_at\":\"2026-08-18\",\"client_id\":$BAD}"
  jq -c '.detail[0] | {loc, type}' /tmp/b1_bad.json
done            # all 422, loc ["body","client_id"]
[ "$(cnt "$TOKEN_A")" = "$B4" ] && echo "NO ROWS CREATED ok"
```
- **Note**: `"client_id": null` and an **omitted** `client_id` are the two legal
  "no key" spellings — they must both be **201** (covered in TC-B1-6), not 422.
- **Status**: ⏸ pending — EXECUTE AT /test

### TC-B1-2: replay on the wire — 201 then 200, same row, one row in the list
- **Why curl** (deliberate overlap with pytest test 1): the mobile outbox's entire
  contract is *the HTTP status on the second call*. pytest asserts it through
  `ASGITransport`; this asserts it through real uvicorn, and additionally proves
  the second response is **byte-identical** to the first (pytest compares json).
- **Expected**: 1st **201**; 2nd **200**; both bodies byte-identical (same `id`, same
  `created_at`); `total == 1`; DB `client_id` on that row == the key sent.
- **curl**:
```bash
export K1=$(mkuuid)
post "$TOKEN_A" "$(body $K1 1000)" | tee /tmp/b1_r1.txt   # ...201
post "$TOKEN_A" "$(body $K1 1000)" | tee /tmp/b1_r2.txt   # ...200
head -1 /tmp/b1_r1.txt > /tmp/b1_b1.json; head -1 /tmp/b1_r2.txt > /tmp/b1_b2.json
diff /tmp/b1_b1.json /tmp/b1_b2.json && echo "BYTE-IDENTICAL BODY"
export TX1=$(jq -r '.id' /tmp/b1_b1.json)
cnt "$TOKEN_A"                                             # 1
psql_q "SELECT client_id='$K1' FROM transactions WHERE id='$TX1'"   # t
```
- **Order dependency**: TC-B1-3, -5, -8-adjacent checks reuse `$K1`/`$TX1`. Run in order.
- **Status**: ⏸ pending — EXECUTE AT /test

### TC-B1-3: a hit is a **pure read** — replay carrying a foreign/garbage `category_id` still returns the stored row
- **Why curl**: this is the no-oracle + skip-all-validation ruling (plan §3.2(3),
  skip-list items 1/2/4) at the **wire** level, with a *cross-user* reference — a
  security-shaped assertion the house requires live. pytest test 6 covers the
  archived-category variant; this covers the foreign-reference variant and is not
  a repeat of it.
- **Depends on**: TC-B1-2 (`$K1`, `$TX1`).
- **Expected**: **200** with A's stored row (`id == $TX1`, original `amount_minor` and
  `category_id`), **NOT** `422 CATEGORY_NOT_FOUND`, **NOT** 404, and no hint that
  `$B_EXP` exists. `total` still 1.
- **curl**:
```bash
curl -s -w '\n%{http_code}\n' -X POST $BASE/transactions -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' \
  -d "{\"amount_minor\":999999,\"kind\":\"income\",\"occurred_at\":\"2020-01-01\",\"category_id\":\"$B_EXP\",\"note\":\"tampered\",\"client_id\":\"$K1\"}"
# expect 200 + the ORIGINAL body:
diff <(curl -s -X POST $BASE/transactions -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' \
      -d "{\"amount_minor\":999999,\"kind\":\"income\",\"occurred_at\":\"2020-01-01\",\"category_id\":\"$(mkuuid)\",\"note\":\"x\",\"client_id\":\"$K1\"}") /tmp/b1_b1.json \
  && echo "STORED ROW RETURNED, VALIDATION SKIPPED"
cnt "$TOKEN_A"                                             # still 1
```
- **Status**: ⏸ pending — EXECUTE AT /test

### TC-B1-4: cross-user isolation — the same uuid for two users is two rows, no leak
- **Why curl** (deliberate overlap with pytest test 3): the house rule is that the
  cross-user *wire bytes* are proven live. It also proves the miss path still runs
  validation for user B (B's own category required).
- **Depends on**: TC-B1-2 (`$K1` already used by A).
- **Expected**: B posts `$K1` with `$B_EXP` → **201** (not 200, not 409, not 500) with an
  `id` **different** from `$TX1`; B's `total == 1`, A's `total == 1`; DB shows two rows
  with the same `client_id` and different `user_id`. B posting `$K1` with **A's**
  category (`$A_EXP`) → **422 CATEGORY_NOT_FOUND** (a miss runs today's validation;
  no cross-user hit, no oracle).
- **curl**:
```bash
curl -s -w '\n%{http_code}\n' -X POST $BASE/transactions -H "Authorization: Bearer $TOKEN_B" -H 'Content-Type: application/json' \
  -d "{\"amount_minor\":2500,\"kind\":\"expense\",\"occurred_at\":\"2026-08-18\",\"category_id\":\"$B_EXP\",\"client_id\":\"$K1\"}" > /tmp/b1_bcreate.txt
head -1 /tmp/b1_bcreate.txt | jq -r '.id'                  # != $TX1
tail -1 /tmp/b1_bcreate.txt                                # 201
export K2=$(mkuuid)
curl -s -w '\n%{http_code}\n' -X POST $BASE/transactions -H "Authorization: Bearer $TOKEN_B" -H 'Content-Type: application/json' \
  -d "{\"amount_minor\":2500,\"kind\":\"expense\",\"occurred_at\":\"2026-08-18\",\"category_id\":\"$A_EXP\",\"client_id\":\"$K2\"}"   # 422 CATEGORY_NOT_FOUND
cnt "$TOKEN_A"; cnt "$TOKEN_B"                             # 1 ; 1
psql_q "SELECT count(DISTINCT user_id) FROM transactions WHERE client_id='$K1'"   # 2
```
- **Status**: ⏸ pending — EXECUTE AT /test

### TC-B1-5: auth is NOT bypassed by a hit
- **Why curl**: plan §3.4 states auth is the one thing *not* skipped on the replay
  path. A lookup placed above `Depends(current_active_user)` (or a router-level
  slip) would turn a stolen `client_id` into a data read. Router-level auth is
  tested once per router by house rule — this is that once, with the new arm.
- **Depends on**: TC-B1-2 (`$K1` is a live key belonging to A).
- **Expected**: no token → **401**; garbage token → **401**. Never 200, never a body
  containing `$TX1`.
- **curl**:
```bash
curl -s -w '\n%{http_code}\n' -X POST $BASE/transactions -H 'Content-Type: application/json' -d "$(body $K1 1000)"                      # 401
curl -s -w '\n%{http_code}\n' -X POST $BASE/transactions -H 'Authorization: Bearer nope.nope.nope' -H 'Content-Type: application/json' -d "$(body $K1 1000)"  # 401
```
- **Status**: ⏸ pending — EXECUTE AT /test

### TC-B1-6: the web shape is byte-unchanged — no `client_id` ⇒ never deduplicated
- **Why curl** (thin overlap with pytest test 4): pytest pins the missing-guard bug at
  the DB level; the live check additionally pins that the **response body key set**
  is exactly today's `TransactionRead` (no `client_id` leaked into the read model,
  O-1/O-8) and that an explicit `"client_id": null` behaves as "absent".
- **Expected**: two identical no-key POSTs → **201, 201** with different `id`s;
  `"client_id": null` POST → **201**; `total` grows by exactly 3; the 201 body's key
  set == the committed `TransactionRead` property set (and contains **no**
  `client_id`); the three rows have `client_id IS NULL` in the DB.
- **curl**:
```bash
B4=$(cnt "$TOKEN_A")
post "$TOKEN_A" "$(body - 1500)" | tee /tmp/b1_n1.txt      # 201
post "$TOKEN_A" "$(body - 1500)" | tee /tmp/b1_n2.txt      # 201, different id
curl -s -w '\n%{http_code}\n' -X POST $BASE/transactions -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' \
  -d "{\"amount_minor\":1500,\"kind\":\"expense\",\"occurred_at\":\"2026-08-18\",\"category_id\":\"$A_EXP\",\"client_id\":null}"   # 201
[ "$(head -1 /tmp/b1_n1.txt | jq -r .id)" != "$(head -1 /tmp/b1_n2.txt | jq -r .id)" ] && echo "TWO DISTINCT ROWS ok"
[ "$(cnt "$TOKEN_A")" = "$((B4+3))" ] && echo "+3 ok"
diff <(head -1 /tmp/b1_n1.txt | jq -r 'keys_unsorted|sort|join(",")') \
     <(jq -r '.components.schemas.TransactionRead.properties|keys|sort|join(",")' $API/openapi.json) && echo "READ SHAPE UNCHANGED (no client_id)"
psql_q "SELECT count(*) FROM transactions WHERE user_id='$A_ID' AND client_id IS NULL"   # 3
```
- **Status**: ⏸ pending — EXECUTE AT /test

### TC-B1-7: UUID canonicalization — uppercase / urn / braced spellings of the SAME key
- **Why curl**: no pytest in plan §5 touches this, and it is a live mobile risk —
  a native iOS `UUID().uuidString` is **UPPERCASE**, while `crypto.randomUUID()` is
  lowercase. If Pydantic normalizes (it should: `uuid.UUID` parses all three forms to
  one canonical value), the uppercase replay is a **200 hit**; if any layer compared
  strings instead of uuids, it would be a **201 duplicate** — a silent double-booking.
- **Depends on**: TC-B1-2 (`$K1`, `$TX1`).
- **Expected (my prediction, to be confirmed live)**: uppercase `$K1` → **200** with
  `id == $TX1`; `urn:uuid:$K1` → **200**, same id; `{$K1}` → **200**, same id;
  `total` unchanged. **Any 201 here is a ❌ finding** (duplicate row from a mere
  spelling difference), not an adaptation.
- **curl**:
```bash
T0=$(cnt "$TOKEN_A")
for FORM in "$(echo $K1 | tr 'a-f' 'A-F')" "urn:uuid:$K1" "{$K1}"; do
  printf '%s -> ' "$FORM"
  curl -s -w ' %{http_code}\n' -X POST $BASE/transactions -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' \
    -d "{\"amount_minor\":1000,\"kind\":\"expense\",\"occurred_at\":\"2026-08-18\",\"category_id\":\"$A_EXP\",\"client_id\":\"$FORM\"}" | jq -r '.id // .detail'
done            # each: 200 + $TX1
[ "$(cnt "$TOKEN_A")" = "$T0" ] && echo "NO DUPLICATE FROM SPELLING ok"
```
- **Boundary extra**: the nil uuid `00000000-0000-0000-0000-000000000000` is a legal
  key — first POST **201**, replay **200**, one row. Assert it, don't special-case it.
- **Status**: ⏸ pending — EXECUTE AT /test

### TC-B1-8: real-server concurrency — N parallel identical POSTs ⇒ exactly one row
- **Why curl** (deliberate overlap with pytest test 7, whose own honesty note says it
  is probabilistic): separate curl **processes** against real uvicorn + a real asyncpg
  pool is the closest thing to the actual outbox-flush-on-reconnect double-fire. It is
  also the only place the `IntegrityError` recovery arm can be hit for real (pytest
  §5.7 reaches it only by patching the lookup).
- **Expected**: of 4 responses, exactly **one 201** and **three 200**; all four bodies
  carry the same `id`; `total` grows by exactly 1; **zero 500s**; if the recovery arm
  fired, the server log carries exactly the `idempotent replay recovered from insert
  race user=…` line (plan §4(4)) and that line contains **no amount and no note**.
- **curl**:
```bash
export K3=$(mkuuid); T0=$(cnt "$TOKEN_A")
for i in 1 2 3 4; do
  ( curl -s -o /tmp/b1_c$i.json -w "%{http_code}\n" -X POST $BASE/transactions \
      -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' -d "$(body $K3 4200)" >> /tmp/b1_codes.txt ) &
done; wait
sort /tmp/b1_codes.txt | uniq -c            # 1x201, 3x200, no 5xx
jq -r '.id' /tmp/b1_c[1-4].json | sort -u | wc -l    # 1
[ "$(cnt "$TOKEN_A")" = "$((T0+1))" ] && echo "EXACTLY ONE ROW ok"
psql_q "SELECT count(*) FROM transactions WHERE user_id='$A_ID' AND client_id='$K3'"   # 1
grep -i 'idempotent replay recovered' <uvicorn log>   # 0 or N lines; must NOT contain amount/note
```
- **Status**: ⏸ pending — EXECUTE AT /test

### TC-B1-9: the DDL fact — partial unique index exists and is enforced by Postgres
- **Why curl/psql**: plan §5 deliberately writes **no** pytest for the column/index
  ("migrations + `alembic check`"). The index *is* the invariant of B-1, so it gets
  the house's DDL-level proof (receipts TC-S1-3 / currencies-goals TC-S1-2 precedent):
  a raw INSERT bypassing the app must be rejected, and NULLs must be exempt.
- **Expected**: column `transactions.client_id` exists, type `uuid`, `is_nullable=YES`;
  index `uq_transactions_user_id_client_id` exists, `indisunique = t`, and its
  definition carries `WHERE (client_id IS NOT NULL)`; a raw duplicate `(user_id,
  client_id)` INSERT is **rejected naming that index**; two raw rows with
  `client_id IS NULL` for the same user are **accepted** (partial exemption); an
  identical `client_id` for a *different* user is **accepted**.
- **psql** (run on **budget_test** so the live DB is untouched; upgrade it to head first):
```bash
cd "$API" && DATABASE_URL="$ADB" uv run alembic upgrade head && DATABASE_URL="$ADB" uv run alembic check
psql "$TDB" -tAc "SELECT data_type,is_nullable FROM information_schema.columns WHERE table_name='transactions' AND column_name='client_id';"   # uuid|YES
psql "$TDB" -tAc "SELECT indexdef FROM pg_indexes WHERE indexname='uq_transactions_user_id_client_id';"   # UNIQUE ... (user_id, client_id) WHERE (client_id IS NOT NULL)
U1=00000000-0000-0000-0000-0000000000b1; U2=00000000-0000-0000-0000-0000000000b2; K=11111111-1111-1111-1111-111111111111
psql "$TDB" -c "INSERT INTO users(id,email,hashed_password) VALUES ('$U1','qa-b1a@x','x'),('$U2','qa-b1b@x','x');"
ins() { psql "$TDB" -c "INSERT INTO transactions(id,user_id,amount_minor,kind,currency,occurred_at,client_id) VALUES (gen_random_uuid(),'$1',100,'expense','RUB','2026-08-18',$2);"; }
ins $U1 "'$K'"                         # ok
ins $U1 "'$K'" 2>&1 | grep -qi 'uq_transactions_user_id_client_id' && echo "PARTIAL UNIQUE LIVE"
ins $U2 "'$K'" && echo "PER-USER SCOPING ok"
ins $U1 NULL && ins $U1 NULL && echo "NULLS EXEMPT ok"
psql "$TDB" -c "DELETE FROM users WHERE id IN ('$U1','$U2');"   # cascade cleanup
```
- **Area M note**: this is DDL-level work on **budget_test** — run with **no pytest
  session active**; the DB is expendable.
- **Status**: ⏸ pending — EXECUTE AT /test

### TC-B1-10: migration is symmetric (downgrade drops index+column, re-upgrade rebuilds)
- **Why curl/psql**: pytest's `_migrated_schema` only does `upgrade head`; the
  intermediate downgrade is never walked (receipts TC-S1-4 precedent). Plan §7 promises
  a symmetric downgrade.
- **Depends on**: TC-B1-9 (budget_test at head). Destructive to **budget_test** only.
- **Expected**: `downgrade -1` → column gone AND index gone; re-`upgrade head` → both
  back; `alembic check` clean both times.
- **cmd**:
```bash
cd "$API"
DATABASE_URL="$ADB" uv run alembic downgrade -1
psql "$TDB" -tAc "SELECT count(*) FROM information_schema.columns WHERE table_name='transactions' AND column_name='client_id';"  # 0
psql "$TDB" -tAc "SELECT count(*) FROM pg_indexes WHERE indexname='uq_transactions_user_id_client_id';"                          # 0
DATABASE_URL="$ADB" uv run alembic upgrade head
psql "$TDB" -tAc "SELECT count(*) FROM information_schema.columns WHERE table_name='transactions' AND column_name='client_id';"  # 1
psql "$TDB" -tAc "SELECT count(*) FROM pg_indexes WHERE indexname='uq_transactions_user_id_client_id';"                          # 1
DATABASE_URL="$ADB" uv run alembic check                                                                                          # clean
```
- **Status**: ⏸ pending — EXECUTE AT /test

### TC-B1-11: the contract — both success arms declared, `client_id` on Create only, live == committed
- **Why curl**: O-8/O-9 are the artifacts the generated mobile client is built from;
  `test_openapi_export.py` only proves live==committed, not the *shape*.
- **Expected**: `POST /transactions` `responses` has **both** `"200"` and `"201"`, each
  `$ref`-ing `TransactionRead`; `TransactionCreate.properties.client_id` exists with
  `format: uuid` and a nullable spelling (`anyOf: [{type:string,format:uuid},{type:null}]`);
  `TransactionRead.properties` has **no** `client_id`; `TransactionUpdate` has **no**
  `client_id`; live `/openapi.json` **deep-equals** committed `apps/api/openapi.json`;
  the generated `schema.d.ts` carries `client_id` in the create body; re-running
  `pnpm openapi` leaves a **zero** `git status --porcelain` on both artifacts.
- **cmd**:
```bash
curl -s $BASE/openapi.json > /tmp/b1_live.json
jq -r '.paths."/transactions".post.responses | keys | join(",")' /tmp/b1_live.json                                   # 200,201,422 (both success arms)
jq -r '.paths."/transactions".post.responses["200"].content."application/json".schema."$ref"' /tmp/b1_live.json      # .../TransactionRead
jq -r '.paths."/transactions".post.responses["201"].content."application/json".schema."$ref"' /tmp/b1_live.json      # .../TransactionRead
jq -c '.components.schemas.TransactionCreate.properties.client_id' /tmp/b1_live.json                                 # uuid, nullable
jq -r '.components.schemas.TransactionRead.properties   | has("client_id")' /tmp/b1_live.json                        # false
jq -r '.components.schemas.TransactionUpdate.properties | has("client_id")' /tmp/b1_live.json                        # false
python3 -c "import json,sys; a=json.load(open('/tmp/b1_live.json')); b=json.load(open('$API/openapi.json')); print('DEEP-EQUAL' if a==b else 'DRIFT')"
grep -c 'client_id' $ROOT/packages/api-client/src/generated/schema.d.ts                                              # >= 1
cd $ROOT && pnpm openapi && git status --porcelain apps/api/openapi.json packages/api-client/src/generated/schema.d.ts   # empty
```
- **Status**: ⏸ pending — EXECUTE AT /test

### TC-B1-12: `client_id` on PATCH is inert (no accidental second write surface)
- **Why curl**: O-1 says `TransactionUpdate` is untouched. Pydantic's default is to
  **ignore** unknown keys, so the realistic failure is not a 422 but a silent
  acceptance that a client could mistake for "PATCH is idempotent too".
- **Depends on**: TC-B1-2 (`$TX1`).
- **Expected**: PATCH with a `client_id` in the body → **200**, the field is ignored,
  and the row's stored `client_id` is **unchanged** (still `$K1`). A second identical
  PATCH is a normal PATCH (200), **not** a replay.
- **curl**:
```bash
curl -s -o /dev/null -w 'patch %{http_code}\n' -X PATCH $BASE/transactions/$TX1 -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' \
  -d "{\"note\":\"patched\",\"client_id\":\"$(mkuuid)\"}"        # 200
psql_q "SELECT client_id='$K1' FROM transactions WHERE id='$TX1'"  # t (unchanged)
```
- **Status**: ⏸ pending — EXECUTE AT /test

### TC-B1-13: replay after DELETE — what a user actually hits (**answer required, see Q1**)
- **Why curl**: a genuine user journey no pytest covers: the outbox retries a POST
  after the user deleted the created transaction in another client/session. Because
  the row is gone, the lookup is a **miss** and today's create path runs.
- **Expected (documented behaviour, to be confirmed then ruled on)**: DELETE `$TX1`
  → **204**; POST `$K1` again → **201** with a **new** id (the transaction is
  resurrected), `total` +1. If senior-lead/PM rules that resurrection is wrong, this
  becomes a design change, not a test fix — I report, I do not fix.
- **curl**:
```bash
curl -s -o /dev/null -w 'del %{http_code}\n' -X DELETE $BASE/transactions/$TX1 -H "Authorization: Bearer $TOKEN_A"   # 204
post "$TOKEN_A" "$(body $K1 1000)"        # 201 + NEW id  (record the actual)
```
- **Order**: run **last** among the `$K1` cases — it destroys `$TX1`.
- **Status**: ⏸ pending — EXECUTE AT /test

### TC-B1-14: regression smoke of the surrounding transactions API
- **Why curl**: B-1 restructures the router's busiest handler and injects a `Response`
  parameter. The promise is "everything else byte-identical". A replay must also be
  invisible to every read surface (counted once, exported once).
- **Expected**: `GET /transactions` envelope `{items,total}` with today's ordering and
  filters (`from`/`to`/`kind`/`category_id`/`limit`/`offset`) behaving as before;
  `GET /transactions/summary?month=2026-08` counts each replayed transaction **once**
  and its `expense_minor` matches the hand-sum of the rows created above;
  `GET /transactions/export` still returns `200 text/csv; charset=utf-8` with the BOM
  and `content-disposition: attachment`, one CSV data row per stored row (no duplicate
  line for the replay); `GET /transactions/{id}` 200 own / 404 foreign;
  `POST /transactions` with `amount_minor: 0` still **422** (unchanged pre-existing
  validation, proving the new first-statement lookup did not swallow it).
- **curl**:
```bash
curl -s "$BASE/transactions?limit=200" -H "Authorization: Bearer $TOKEN_A" | jq '{total, n:(.items|length), keys:(.items[0]|keys_unsorted)}'
curl -s "$BASE/transactions?kind=expense&from=2026-08-01&to=2026-08-31" -H "Authorization: Bearer $TOKEN_A" | jq '.total'
curl -s "$BASE/transactions/summary?month=2026-08" -H "Authorization: Bearer $TOKEN_A" | jq '{currency,income_minor,expense_minor,net_minor,unconverted_count}'
curl -s -D- -o /tmp/b1.csv "$BASE/transactions/export?from=2026-08-01&to=2026-08-31" -H "Authorization: Bearer $TOKEN_A" | grep -i 'content-type\|content-disposition'
wc -l /tmp/b1.csv                                  # header + exactly one row per stored tx
curl -s -o /dev/null -w 'zero %{http_code}\n' -X POST $BASE/transactions -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' \
  -d "{\"amount_minor\":0,\"kind\":\"expense\",\"occurred_at\":\"2026-08-18\",\"client_id\":\"$(mkuuid)\"}"     # 422
```
- **Status**: ⏸ pending — EXECUTE AT /test

### TC-Z1: full pytest suite green (Section A verification)
```bash
cd $API && uv run pytest        # or `pnpm --filter @budget/api test`
```
- **Expected**: all green, including the new `tests/test_transaction_idempotency.py`
  (7 tests + the §5.7 race arm) and `tests/test_openapi_export.py`. Any failure →
  capture, **do NOT fix backend code**, escalate to senior-lead.
- **Status**: ⏸ pending — EXECUTE AT /test

---

## Covered by pytest — NOT repeated here (plan.md §5, backend-engineer owns)

| plan §5 | test name | why curl does not repeat it |
|---|---|---|
| 1 | `test_replay_returns_200_with_the_stored_row` | DB-count + json-equality proof; TC-B1-2 is the wire/byte-identity layer on a real server, not a re-run |
| 2 | `test_replay_ignores_a_changed_body` | first-write-wins is a pure business ruling — fully deterministic, no live value |
| 3 | `test_same_client_id_for_two_users_creates_two_rows` | TC-B1-4 is the live security **wire** (house rule); the row-level assertion stays pytest's |
| 4 | `test_creates_without_client_id_are_never_deduplicated` | the `is not None` guard is pinned in pytest; TC-B1-6 only adds the response-shape/openapi-key assertion |
| 5 | `test_replay_does_not_relearn_the_merchant_map` | needs `merchant_category_map.updated_at` inspection across three writes — pytest's job; I do not re-assert skip-list item 7 |
| 6 | `test_replay_after_the_category_was_archived_still_returns_200` | the §3.2 placement ruling; deterministic. TC-B1-3 covers the *different* foreign-reference variant |
| 7 | `test_concurrent_replays_create_exactly_one_row` | TC-B1-8 is the multi-process/real-uvicorn complement the test's own honesty note asks for |
| §5.7 | `test_insert_race_recovers_and_returns_the_existing_row` | needs `@patch` of an internal — unreachable from curl by construction |

Also **not** mine: `alembic check` cleanliness as a *gate* (backend O-3 — I re-run it
as PC-A/TC-B1-9 evidence, not as a substitute), and the `pnpm openapi` zero-diff
(backend O-9 — I verify the artifact, backend produces it).

---

## Questions for senior-lead (raise BEFORE implementation; they can change the plan)

- **Q1 — replay after delete resurrects the transaction (TC-B1-13).** A queued outbox
  item retried after the user deleted the row re-creates it with a new id. Is that the
  intended semantic (the key is only as durable as the row), or should a deleted
  `client_id` be tombstoned? I recommend **accept + document** (tombstoning needs a new
  table and the mobile client never queues a create for a row it just deleted), but it
  must be a decision, not an accident.
- **Q2 — UUID spelling (TC-B1-7).** Confirm the client contract obliges the mobile side
  to send a canonical lowercase uuid. Pydantic should normalize uppercase/urn/braced
  forms, but if any of them ever produced a 201 it would be a silent double-book. If
  M-4 mints keys with `crypto.randomUUID()` this is safe by construction — please
  confirm that is the mechanism.
- **Q3 — 200 vs 201 on replay is still open in the plan (§8 Q1).** If PM rules
  "always 201", TC-B1-2/-3/-7/-8 status assertions flip; the checklist otherwise stands.
  I need the ruling before /test, not during.
- **Q4 — no rate limit on `POST /transactions`** (plan §3.4, grep-confirmed). An outbox
  flush after a long offline stretch fires N creates back to back with no throttle. Is
  that accepted for this scope? If a limit is ever added, the *replay* arm must be
  exempt or the client will park rows it already booked. Flagging now, not asking for
  work.
- **Q5 — `client_id` is absent from `TransactionRead` (architecture Decision 3).** The
  client therefore cannot reconcile a queued item to a server row by key — only by the
  returned `id` on the 200/201. Confirm M-4 persists the returned `id` at flush time;
  otherwise a crash between the server commit and the client's ack leaves an item whose
  only reconciliation path is a re-POST (which is fine — it is a 200 — but it should be
  the deliberate design).

---

## Final report (filled at B-1's /test)

Total: 15 (TC-B1-1..14 + TC-Z1) / Passed: — / Failed: — / Blocked: —
Status: ⏸ **NOT RUN — B-1 not implemented** (scope sequenced after `recurring-and-limits`).
Any ❌ → **FAIL OVERALL**, senior-lead handles; I do not fix backend code.
All green → ✅ **READY FOR REVIEW**.

**Cleanup obligation at /test** (house discipline): delete the two run-scoped
`@budgetqa.dev` users (cascade removes their transactions + categories + tokens),
verify residue 0, kill any uvicorn I started, and leave `budget_test` at head. No
non-QA rows touched, no backend/compose/conftest/.env edits, no commits.
