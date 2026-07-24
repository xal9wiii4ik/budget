# QA Checklist: categories-api (roadmap 1.3)

## Scope

Live-wire (curl) verification of the three category routes — `GET /categories`,
`POST /categories`, `PATCH /categories/{id}` — mounted at prefix `/categories`
per the accepted plan.md **as amended by the senior AM-1/AM-2** (see below).
This checklist is written at grooming; it is executed at **/test after
/implement**. Do NOT run curl now.

**This is Section B (curl, QA-owned).** Section A (pytest) is owned by
backend-engineer per plan.md's Test plan (`tests/test_categories.py`). At /test I
also run `make test` / `pnpm test` and confirm the pytest suite is green (TC-Z1);
I do not write or fix that code.

**Binding senior amendments this checklist is written against** (the plan folds
them at /implement):
- **AM-1**: the PATCH dedup check triggers on the *effective new `(name, kind)`
  pair* — a **kind-only** PATCH that produces a duplicate pair → `409
  CATEGORY_NAME_CONFLICT` (not only renames trigger it). → **TC-18**.
- **AM-2**: the update dedup query **excludes the target row itself** — a
  case-only self-rename (`"Foo"` → `"foo"`) → **200**, not 409. → **TC-19**.
- Plan's pytest list gains one update-path dedup test (rename-collision 409 +
  self-rename 200); I do not re-write it, I verify the same two behaviours live.

**Out of scope here (pytest owns; see Division of labor at the end):** model-level
CHECK enforcement (1.2 `test_core_model.py`), cross-user list read isolation
(`test_does_not_leak_other_users_categories`), the internal `model_fields_set`
mechanics beyond their observable wire effect, dedup raciness (accepted
single-user, plan decision d).

## Stable detail codes (business errors, `{"detail": "<CODE>"}` string envelope)

| Code | Where |
|---|---|
| `SYSTEM_CATEGORY_READONLY` | PATCH a `user_id IS NULL` seed row → 403 |
| `CATEGORY_NOT_FOUND` | PATCH a cross-user id OR a nonexistent id → 404 (byte-identical) |
| `CATEGORY_NAME_CONFLICT` | create/update collides with own non-archived same-`(name,kind)` → 409 |

**Envelope contrast (load-bearing):** business errors return `detail` as a
**string code** (`{"detail":"CATEGORY_NOT_FOUND"}`). Pydantic 422 rejections
return `detail` as an **array** of error objects
(`{"detail":[{"type":...,"loc":...,"msg":...}]}`). Several TCs assert *which*
shape appears — that distinction is itself the contract.

---

## Preconditions

Run these once at the start of /test and keep the shell env for the chained TCs.

### Environment

```bash
export BASE=http://localhost:8010                 # /test run: PM instruction PORT 8010 (was 8000)
# Live server DB per apps/api/.env (standing local PG on 5443, db `budget`):
export PGURI='postgresql://budget:budget@localhost:5443/budget'
psql_q() { PGPASSWORD=budget psql -h localhost -p 5443 -U budget -d budget -tAc "$1"; }
```

> **/test EXECUTION ADAPTATIONS (senior rulings, applied 2026-07-24):**
> - Server started by QA via `uv run uvicorn budget_api.app:create_app --factory
>   --port 8010` from `apps/api`. `apps/api/.env` confirmed → `…@localhost:5443/budget`
>   before start. docker-compose.yml / 5433 untouched.
> - **Migration setup:** the live `budget` DB was at alembic `0001` (no `categories`
>   table). Applied `alembic upgrade head` (0002 core tables, 0003 seed) → 18 seeds
>   present. This is env setup, not a code change.
> - TC-21(c) same-commit check degraded to a working-tree check (no commits by
>   design); same-commit rule deferred to the actual commit. See TC-21 status.
> - Note (senior gate fix, no new TC): `PATCH {"archived": null}` → 422
>   `CATEGORY_ARCHIVED_REQUIRED` (pytest-covered).

> NOTE on the 5443/5433 split (core-data-model §5/§7 standing rule): the committed
> `docker-compose.yml` maps `5433:5432`, but `apps/api/.env` points the live app at
> **5443** (the standing local PG). The running uvicorn server therefore reads/writes
> `…@localhost:5443/budget`. All psql verification queries below target 5443/`budget`
> (the app's live DB), NOT `budget_test` (that is pytest's DB on the same server).

### PC-1 — server up (liveness + real DB round-trip)

```bash
curl -s -o /dev/null -w '%{http_code}\n' $BASE/health
curl -s $BASE/health
```
- **Expected**: `200`, body `{"status":"ok","database":"ok"}`. If not 200 → **STOP**,
  the server/DB is not ready; report to senior-lead. (Everything below is blocked.)

### PC-2 — DB reachable for verification queries

```bash
psql_q 'SELECT 1'
```
- **Expected**: `1`. If it errors → psql checks (TC-6 ownership, etc.) are ⏸ blocked.

### PC-3 — register + login two users, capture tokens + ids

Login is **form-encoded** (carry-forward from 1.1): `Content-Type:
application/x-www-form-urlencoded`, field `username` = the email. `curl --data`
sends form-encoded by default. Unique emails per run avoid `REGISTER_USER_ALREADY_EXISTS`
from leftover rows in the shared live `budget` DB.

```bash
export RUN=$(date +%s)
export EMAIL_A="qa_a_${RUN}@x.com"
export EMAIL_B="qa_b_${RUN}@x.com"
export PW="password123"

# Register A and B (stock register → 201, UserRead {id,email,is_active})
curl -s -o /dev/null -w 'regA %{http_code}\n' -X POST $BASE/auth/register \
  -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL_A\",\"password\":\"$PW\"}"
curl -s -o /dev/null -w 'regB %{http_code}\n' -X POST $BASE/auth/register \
  -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL_B\",\"password\":\"$PW\"}"

# Login (form-encoded, username=email) → {access_token, refresh_token}
export TOKEN_A=$(curl -s -X POST $BASE/auth/login \
  --data "username=$EMAIL_A&password=$PW" | jq -r '.access_token')
export TOKEN_B=$(curl -s -X POST $BASE/auth/login \
  --data "username=$EMAIL_B&password=$PW" | jq -r '.access_token')

# Capture A's user id (needed for the forced-ownership DB check, TC-6)
export A_ID=$(curl -s $BASE/users/me -H "Authorization: Bearer $TOKEN_A" | jq -r '.id')

echo "A_ID=$A_ID  TOKEN_A=${TOKEN_A:0:12}…  TOKEN_B=${TOKEN_B:0:12}…"
```
- **Expected**: `regA 201`, `regB 201`; both logins yield a non-empty
  `access_token`; `A_ID` is a UUID. If any is empty → **STOP**, downstream TCs are
  blocked.

---

## Test cases

### TC-1: GET /categories without token → 401
- **Method/Endpoint**: GET `/categories`
- **Headers**: none
- **Expected**: `401`. (Router-level auth via `current_active_user`. Tested once
  per method on this router — see TC-2/TC-3 for the other verbs.)
- **curl**:
```bash
curl -s -o /dev/null -w '%{http_code}\n' $BASE/categories
curl -s $BASE/categories      # body inspection
```
- **Note**: 401 assertions are STATUS-ONLY (TC-1/2/3); the response body prose is
  fastapi-users internals, not the contract.
- **Status**: ✅ pass

### TC-2: POST /categories without token → 401
- **Method/Endpoint**: POST `/categories`
- **Expected**: `401` (auth runs before body validation → not 422).
- **curl**:
```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST $BASE/categories \
  -H 'Content-Type: application/json' -d '{"name":"X","kind":"expense"}'
```
- **Status**: ✅ pass

### TC-3: PATCH /categories/{id} without token → 401
- **Method/Endpoint**: PATCH `/categories/00000000-0000-0000-0000-000000000000`
- **Expected**: `401` (auth before the 404/403 path).
- **curl**:
```bash
curl -s -o /dev/null -w '%{http_code}\n' -X PATCH \
  $BASE/categories/00000000-0000-0000-0000-000000000000 \
  -H 'Content-Type: application/json' -d '{"name":"X"}'
```
- **Status**: ✅ pass

### TC-4: GET /categories merges 18 system seeds + own rows; is_system flags
- **Method/Endpoint**: GET `/categories`
- **Headers**: `Authorization: Bearer $TOKEN_A`
- **Expected**: `200`, JSON array. Exactly **18** rows with `is_system=true`
  (13 `kind=expense` + 5 `kind=income`, `user_id IS NULL` seeds). A known seed is
  present with its frozen shape: `Продукты`/`expense`/`is_system=true`. Any row
  created by A (below) carries `is_system=false`. Order is `kind, name`
  (deterministic — plan decision a).
- **curl**:
```bash
BODY=$(curl -s $BASE/categories -H "Authorization: Bearer $TOKEN_A")
echo "$BODY" | jq 'length'                                              # >= 18
echo "$BODY" | jq '[.[] | select(.is_system==true)] | length'          # == 18
echo "$BODY" | jq '[.[] | select(.is_system==true and .kind=="expense")] | length'  # == 13
echo "$BODY" | jq '[.[] | select(.is_system==true and .kind=="income")]  | length'  # == 5
echo "$BODY" | jq '.[] | select(.name=="Продукты" and .kind=="expense") | {is_system,icon,color}'
# expect {"is_system":true,"icon":"🛒","color":"#4CAF50"}
```
- **DB cross-check** (system-seed count independent of the wire):
```bash
psql_q "SELECT count(*) FROM categories WHERE user_id IS NULL"          # 18
```
- **Status**: ✅ pass

### TC-5: archive lifecycle — default excludes, include_archived shows, unarchive restores
- **Depends on**: PC-3. Creates its own row (chained).
- **Steps / Expected**:
  1. POST creates `TC5-arch`/`expense` → 201, `archived=false`. Appears in default GET.
  2. PATCH `{"archived":true}` → 200, `archived=true`. **Disappears** from default GET.
  3. GET `?include_archived=true` → the row **is present**.
  4. PATCH `{"archived":false}` → 200. Row **reappears** in default GET.
- **curl**:
```bash
CID=$(curl -s -X POST $BASE/categories -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' -d '{"name":"TC5-arch","kind":"expense"}' | jq -r '.id')

curl -s $BASE/categories -H "Authorization: Bearer $TOKEN_A" \
  | jq --arg id "$CID" 'any(.[]; .id==$id)'                             # true (default shows it)

curl -s -X PATCH $BASE/categories/$CID -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' -d '{"archived":true}' | jq '.archived'   # true

curl -s $BASE/categories -H "Authorization: Bearer $TOKEN_A" \
  | jq --arg id "$CID" 'any(.[]; .id==$id)'                             # false (excluded by default)
curl -s "$BASE/categories?include_archived=true" -H "Authorization: Bearer $TOKEN_A" \
  | jq --arg id "$CID" 'any(.[]; .id==$id)'                             # true (shown when asked)

curl -s -X PATCH $BASE/categories/$CID -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' -d '{"archived":false}' | jq '.archived'  # false
curl -s $BASE/categories -H "Authorization: Bearer $TOKEN_A" \
  | jq --arg id "$CID" 'any(.[]; .id==$id)'                             # true (restored)
```
- **Status**: ✅ pass

### TC-6: POST 201 shape + forced ownership (body user_id ignored) — DB check
- **Depends on**: PC-3 (needs `A_ID`).
- **Method/Endpoint**: POST `/categories`
- **Headers**: `Authorization: Bearer $TOKEN_A`, `Content-Type: application/json`
- **Body**: includes a **bogus `user_id`** that must be ignored:
```json
{"name":"TC6-own","kind":"expense","icon":"🎯","color":"#123456",
 "user_id":"11111111-1111-1111-1111-111111111111"}
```
- **Expected**: `201`. Response object has keys `id, name, icon, color, kind,
  archived, is_system` with `is_system=false`, `archived=false`, `kind="expense"`,
  `icon="🎯"`, `color="#123456"`, and **no `user_id` key on the wire** (derived
  `is_system` replaces it — plan decision b). The stored `user_id` in the DB is
  **`$A_ID`**, NOT the bogus body value (forced ownership — the wire can't prove
  this, so psql does).
- **curl + DB check**:
```bash
CID=$(curl -s -X POST $BASE/categories -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' \
  -d '{"name":"TC6-own","kind":"expense","icon":"🎯","color":"#123456","user_id":"11111111-1111-1111-1111-111111111111"}' \
  | tee /dev/stderr | jq -r '.id')

# Response shape: is_system false, no user_id leaked
curl -s $BASE/categories -H "Authorization: Bearer $TOKEN_A" \
  | jq --arg id "$CID" '.[] | select(.id==$id) | {is_system, has_user_id: has("user_id")}'
#   expect {"is_system":false,"has_user_id":false}

# Forced ownership — stored user_id is A's id, not the bogus body value:
psql_q "SELECT user_id='$A_ID' FROM categories WHERE id='$CID'"        # t
psql_q "SELECT user_id FROM categories WHERE id='$CID'"                # == $A_ID (NOT 1111…)
```
- **Status**: ✅ pass

### TC-7: color regex rejects invalid + short form → 422 (live wire)
- **Method/Endpoint**: POST `/categories`, `Authorization: Bearer $TOKEN_A`
- **Expected**: both `422`, with `detail` as a **Pydantic error array** (not a
  string code). Named color `"red"` rejected; 3-digit `"#123"` short form rejected
  (only `^#[0-9A-Fa-f]{6}$` accepted — plan decision c).
- **curl**:
```bash
for C in '"red"' '"#123"' '"#12345G"'; do
  curl -s -o /dev/null -w "color=$C -> %{http_code}\n" -X POST $BASE/categories \
    -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' \
    -d "{\"name\":\"TC7-$RANDOM\",\"kind\":\"expense\",\"color\":$C}"
done
# each -> 422
curl -s -X POST $BASE/categories -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' -d '{"name":"TC7x","kind":"expense","color":"red"}' \
  | jq 'if (.detail|type)=="array" then "pydantic-array-OK" else . end'
```
- **Status**: ✅ pass

### TC-8: name > 100 chars → 422 (Pydantic layer — QA-owned, pytest does NOT cover)
- **Method/Endpoint**: POST `/categories`, `Authorization: Bearer $TOKEN_A`
- **Expected**: `422`, `detail` is a Pydantic error array. (Plan explicitly leaves
  the `>100` / `>16` / invalid-enum length rejections to QA-curl — "pure Pydantic
  rejection, no custom logic on top"; this is my layer per the division of labor.)
- **curl**:
```bash
LONG=$(printf 'x%.0s' {1..101})
curl -s -o /dev/null -w '%{http_code}\n' -X POST $BASE/categories \
  -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' \
  -d "{\"name\":\"$LONG\",\"kind\":\"expense\"}"      # 422
```
- **Status**: ✅ pass

### TC-9: icon > 16 chars → 422 (Pydantic layer — QA-owned)
- **Method/Endpoint**: POST `/categories`, `Authorization: Bearer $TOKEN_A`
- **Expected**: `422`. 17 ASCII code points exceed the `String(16)` / schema
  `max_length=16` bound (plan decision c: code points, not graphemes).
- **curl**:
```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST $BASE/categories \
  -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' \
  -d '{"name":"TC9","kind":"expense","icon":"aaaaaaaaaaaaaaaaa"}'      # 17 chars -> 422
```
- **Status**: ✅ pass

### TC-10: invalid kind enum value → 422 (Pydantic layer — QA-owned)
- **Method/Endpoint**: POST `/categories`, `Authorization: Bearer $TOKEN_A`
- **Expected**: `422`. `kind="transfer"` is not in `CategoryKind` = {expense,income}.
- **curl**:
```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST $BASE/categories \
  -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' \
  -d '{"name":"TC10","kind":"transfer"}'                               # 422
```
- **Status**: ✅ pass

### TC-11: create dedup 409, case-insensitive, same kind
- **Depends on**: PC-3. Chained (create then collide).
- **Expected**: first create `201`; second (`"foo"` vs `"Foo"`, same kind) →
  `409` with `{"detail":"CATEGORY_NAME_CONFLICT"}` (string). Case-insensitive,
  own + same-kind + non-archived (plan decision d).
- **curl**:
```bash
curl -s -o /dev/null -w 'create1 %{http_code}\n' -X POST $BASE/categories \
  -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' \
  -d '{"name":"Foo","kind":"expense"}'                                 # 201
curl -s -w '\ncreate2 %{http_code}\n' -X POST $BASE/categories \
  -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' \
  -d '{"name":"foo","kind":"expense"}'
#   409, body {"detail":"CATEGORY_NAME_CONFLICT"}
```
- **Status**: ✅ pass

### TC-12: same name, different kind → both 201 (dedup is per-kind)
- **Depends on**: TC-11 (reuses `"Foo"`/expense already created).
- **Expected**: `"Foo"`/`income` → `201` (cross-kind allowed — the seeds
  themselves have `Подарки` in both kinds, plan decision d).
- **curl**:
```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST $BASE/categories \
  -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' \
  -d '{"name":"Foo","kind":"income"}'                                  # 201
```
- **Status**: ✅ pass

### TC-13: copying a system-category name → 201 (system names don't block)
- **Method/Endpoint**: POST `/categories`, `Authorization: Bearer $TOKEN_A`
- **Expected**: create `"Продукты"`/`expense` → `201` (a user editable copy of a
  seed; the dedup check ignores `user_id IS NULL` rows — plan decision d). Result
  `is_system=false`, distinct `id` from the seed.
- **curl**:
```bash
curl -s -w '\n%{http_code}\n' -X POST $BASE/categories \
  -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' \
  -d '{"name":"Продукты","kind":"expense"}' | jq -c 'if type=="object" then {is_system,name} else . end'
#   201, {"is_system":false,"name":"Продукты"}
```
- **Status**: ✅ pass

### TC-14: PATCH cross-user id AND nonexistent id → 404 with BYTE-IDENTICAL body
- **Depends on**: PC-3 + one of A's category ids. **Headline security check
  (no-oracle):** a nonexistent id and another user's id must be indistinguishable.
- **Steps**:
  1. Create a category as **A**, capture `A_CAT`.
  2. As **B**, PATCH `A_CAT` → 404. Capture status + raw body.
  3. As **B**, PATCH a random UUID → 404. Capture status + raw body.
  4. `diff` the two raw bodies — must be **empty** (identical bytes), both
     `{"detail":"CATEGORY_NOT_FOUND"}`.
- **curl**:
```bash
A_CAT=$(curl -s -X POST $BASE/categories -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' -d '{"name":"TC14-A","kind":"expense"}' | jq -r '.id')
RAND=$(uuidgen | tr 'A-F' 'a-f')

curl -s -w '\n%{http_code}\n' -X PATCH $BASE/categories/$A_CAT \
  -H "Authorization: Bearer $TOKEN_B" -H 'Content-Type: application/json' \
  -d '{"name":"hax"}' > /tmp/tc14_crossuser.txt
curl -s -w '\n%{http_code}\n' -X PATCH $BASE/categories/$RAND \
  -H "Authorization: Bearer $TOKEN_B" -H 'Content-Type: application/json' \
  -d '{"name":"hax"}' > /tmp/tc14_missing.txt

cat /tmp/tc14_crossuser.txt          # {"detail":"CATEGORY_NOT_FOUND"} then 404
diff /tmp/tc14_crossuser.txt /tmp/tc14_missing.txt && echo "BYTE-IDENTICAL: PASS"
```
- **Expected**: both `404`, both body `{"detail":"CATEGORY_NOT_FOUND"}`, `diff`
  produces no output. Any difference → ❌ (oracle leak).
- **Status**: ✅ pass

### TC-15: PATCH a system seed → 403 SYSTEM_CATEGORY_READONLY
- **Method/Endpoint**: PATCH `/categories/ce814749-2554-40be-8952-3a63d505694f`
  (seed `Продукты`/expense), `Authorization: Bearer $TOKEN_A`
- **Expected**: `403`, `{"detail":"SYSTEM_CATEGORY_READONLY"}`. A user cannot
  rename/recolor/archive a shared `user_id IS NULL` row (carry-forward; archive is
  guarded identically since it rides the same PATCH).
- **curl**:
```bash
curl -s -w '\n%{http_code}\n' -X PATCH \
  $BASE/categories/ce814749-2554-40be-8952-3a63d505694f \
  -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' \
  -d '{"name":"hijacked"}'
#   403, {"detail":"SYSTEM_CATEGORY_READONLY"}
# Also verify archive of a seed is blocked by the same guard:
curl -s -o /dev/null -w 'archive-seed %{http_code}\n' -X PATCH \
  $BASE/categories/ce814749-2554-40be-8952-3a63d505694f \
  -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' \
  -d '{"archived":true}'                                               # 403
```
- **DB guard** (the seed was not mutated):
```bash
psql_q "SELECT name='Продукты' AND archived=false FROM categories WHERE id='ce814749-2554-40be-8952-3a63d505694f'"  # t
```
- **Status**: ✅ pass

### TC-16: PATCH explicit null clears icon; omitted color survives
- **Depends on**: PC-3. Chained. Pins the omitted-vs-explicit-null distinction on
  the wire (plan decision e).
- **Steps**:
  1. Create with `icon="🎯"`, `color="#ABCDEF"`.
  2. PATCH `{"icon": null}` **only** (color omitted from the body).
  3. Expect `200`, `icon` → `null`, `color` → **still `"#ABCDEF"`** (untouched).
- **curl**:
```bash
CID=$(curl -s -X POST $BASE/categories -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' \
  -d '{"name":"TC16","kind":"expense","icon":"🎯","color":"#ABCDEF"}' | jq -r '.id')

curl -s -X PATCH $BASE/categories/$CID -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' -d '{"icon":null}' \
  | jq '{icon, color}'
#   expect {"icon":null,"color":"#ABCDEF"}
```
- **DB cross-check**:
```bash
psql_q "SELECT icon IS NULL AND color='#ABCDEF' FROM categories WHERE id='$CID'"  # t
```
- **Status**: ✅ pass

### TC-17: PATCH kind change → 200 (kind is a hint, flip allowed)
- **Depends on**: PC-3. Chained. Pins plan decision e (kind change allowed).
- **Steps**: create `expense`, PATCH `{"kind":"income"}` → `200`, `kind="income"`.
- **curl**:
```bash
CID=$(curl -s -X POST $BASE/categories -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' -d '{"name":"TC17","kind":"expense"}' | jq -r '.id')
curl -s -X PATCH $BASE/categories/$CID -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' -d '{"kind":"income"}' | jq '.kind'   # "income"
```
- **Status**: ✅ pass

### TC-18: kind-ONLY PATCH that creates a duplicate pair → 409 (AM-1)
- **Depends on**: PC-3. Chained. **This is the AM-1 amendment check** — dedup fires
  on the effective new `(name, kind)` pair, even when `name` is unchanged.
- **Setup**: create `"Bar"`/`expense` and `"Bar"`/`income` (both 201 per TC-12
  logic — cross-kind allowed).
- **Action**: PATCH the **income** `"Bar"` with `{"kind":"expense"}` only. The new
  pair `("Bar","expense")` collides with the existing expense row → **409
  `CATEGORY_NAME_CONFLICT`**.
- **curl**:
```bash
curl -s -o /dev/null -w 'bar-exp %{http_code}\n' -X POST $BASE/categories \
  -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' \
  -d '{"name":"Bar","kind":"expense"}'                                 # 201
BAR_INC=$(curl -s -X POST $BASE/categories -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' -d '{"name":"Bar","kind":"income"}' | jq -r '.id')   # 201

curl -s -w '\n%{http_code}\n' -X PATCH $BASE/categories/$BAR_INC \
  -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' \
  -d '{"kind":"expense"}'
#   409, {"detail":"CATEGORY_NAME_CONFLICT"}
```
- **Status**: ✅ pass

### TC-19: case-only self-rename → 200 (AM-2, target row excluded from dedup)
- **Depends on**: PC-3. Chained. **AM-2 amendment check** — the dedup query
  excludes the target row itself, so renaming `"Foo"`→`"foo"` on the same row is NOT
  a self-collision.
- **Steps**: create `"Baz"`/`expense`, PATCH `{"name":"baz"}` → **200**,
  `name="baz"` (NOT 409).
- **curl**:
```bash
CID=$(curl -s -X POST $BASE/categories -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' -d '{"name":"Baz","kind":"expense"}' | jq -r '.id')
curl -s -w '\n%{http_code}\n' -X PATCH $BASE/categories/$CID \
  -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' \
  -d '{"name":"baz"}' | head -1
#   200, name "baz"
```
- **Expected**: `200`, body `.name == "baz"`. A `409` here means AM-2 was not
  applied (self-row not excluded) → ❌.
- **Status**: ✅ pass

### TC-20: OpenAPI contract exposes the three /categories operations
- **Runs against**: both the live server `/openapi.json` and the committed
  `apps/api/openapi.json` (they must agree — TC-21 proves the sync).
- **Expected**: `/categories` has `get` + `post`; `/categories/{category_id}` has
  `patch`. (Path param is PINNED as `/categories/{category_id}`.)
- **curl / jq**:
```bash
# Live app schema:
curl -s $BASE/openapi.json | jq '.paths["/categories"] | keys'                    # ["get","post"]
curl -s $BASE/openapi.json | jq '.paths | keys | map(select(startswith("/categories")))'
#   ["/categories","/categories/{category_id}"]
curl -s $BASE/openapi.json | jq '.paths["/categories/{category_id}"] | keys'      # ["patch"]

# Committed artifact (repo):
jq '.paths | keys | map(select(startswith("/categories")))' \
  /Users/nikitazaretski/work/budget/apps/api/openapi.json
```
- **Status**: ✅ pass

### TC-21: contract artifacts in-sync + committed together (drift gates)
- **What**: (a) committed `openapi.json` matches the current app; (b) committed
  `packages/api-client/src/generated/schema.d.ts` matches a fresh regeneration;
  (c) both landed in the **same commit** (standing rule, core-data-model §5/§7).
- **Commands**:
```bash
cd /Users/nikitazaretski/work/budget

# (a) API-side drift test — fails red if openapi.json is stale:
TEST_DATABASE_URL='postgresql+asyncpg://budget:budget@localhost:5443/budget_test' \
  pnpm --filter @budget/api test -- tests/test_openapi_export.py::TestOpenApiExport::test_committed_schema_matches_current_app
#   (or: cd apps/api && uv run pytest tests/test_openapi_export.py)

# (b) Client-side drift test — committed schema.d.ts must be byte-identical to regen:
pnpm --filter @budget/api-client test -- src/drift.test.ts
#   (drift.test.ts compares committed generated/schema.d.ts vs generateSchema())

# (c) Both artifacts in the SAME commit:
git log --oneline -1 -- apps/api/openapi.json
git log --oneline -1 -- packages/api-client/src/generated/schema.d.ts
#   the two SHAs must be identical (regen+commit-together rule). Also confirm both
#   files are listed together in that commit:
git show --stat "$(git log -1 --format=%H -- apps/api/openapi.json)" \
  -- apps/api/openapi.json packages/api-client/src/generated/schema.d.ts
```
- **Expected**: both drift tests **green**; the two `git log` SHAs identical and
  the commit touches both files. Any stale artifact or split commit → ❌.
- **Status**: ✅ pass — (a) API drift test `test_committed_schema_matches_current_app`
  green (1 passed); (b) client `src/drift.test.ts` green (2 passed, no type errors).
  (c) same-commit rule **DEFERRED to the actual commit** (senior ruling: nothing is
  committed by design). Degraded working-tree check: `git status --porcelain` shows
  BOTH `apps/api/openapi.json` AND `packages/api-client/src/generated/schema.d.ts`
  as ` M` (modified together) in the working tree.

### TC-Z1: full pytest suite green (Section A verification)
- **What**: run backend's pytest suite (incl. `tests/test_categories.py` with the
  AM-1/AM-2 update-dedup test) against the test PG on 5443.
- **Command**:
```bash
cd /Users/nikitazaretski/work/budget
TEST_DATABASE_URL='postgresql+asyncpg://budget:budget@localhost:5443/budget_test' \
  pnpm --filter @budget/api test
#   (or: cd apps/api && TEST_DATABASE_URL=…5443/budget_test uv run pytest)
```
- **Expected**: all tests pass. If any fail → capture output, **do NOT fix backend
  code**, escalate to senior-lead.
- **Status**: ✅ pass

---

## Division of labor — what I deliberately do NOT re-check (pytest pins it)

- **kind CHECK constraint enforcement** (`kind IN ('expense','income')` at the DB):
  pinned by 1.2 `test_core_model.py`; the model/migration byte-identity is a
  senior diff-gate item. TC-10 covers only the **Pydantic** enum rejection (422),
  a distinct layer.
- **Cross-user LIST read isolation** (`test_does_not_leak_other_users_categories`):
  pytest owns it. I cover the cross-user **write** path live (TC-14), where the
  no-oracle 404 indistinguishability is the security-critical wire behavior.
- **`model_fields_set` internal mechanics** (omitted vs explicit-null branch):
  pinned by `test_patch_null_clears_and_omitted_preserves`. I verify only the
  observable wire+DB effect (TC-16).
- **Forced-ownership / dedup / kind-change internal logic**: pytest pins each; my
  curl checks (TC-6, TC-11–13, TC-17–19) exist because they add **live-wire**
  value (real HTTP, real body envelopes, the AM-1/AM-2 amendments end-to-end,
  the DB-stored `user_id`), not to duplicate pytest assertions.
- **Whitespace-only name 422** (`test_whitespace_name_rejected`): custom trim
  validator, pytest-owned; not re-run live (curl adds nothing over pytest here).
- **Color case normalization**: none applied (store as-given, plan decision c) —
  nothing to contrast, no TC.
- **Model CHECK ↔ migration 0002 byte-identity / server defaults**: senior diff
  gate + `alembic check`, not a curl concern.

---

## Summary gates (all must be green before merge)

| Gate | TCs | Meaning |
|---|---|---|
| Auth wall | TC-1, TC-2, TC-3 | all three verbs 401 without a token |
| Read merge & visibility | TC-4 | 18 seeds present, is_system correct, own rows flagged |
| Archive semantics | TC-5 | default excludes archived; include_archived shows; unarchive restores |
| Forced ownership | TC-6 | body `user_id` ignored; DB stores caller id; no `user_id` leak |
| Validation (QA layer) | TC-7, TC-8, TC-9, TC-10 | color regex + length/enum → 422 Pydantic array |
| Dedup contract | TC-11, TC-12, TC-13 | 409 case-insens same-kind; cross-kind 201; system-name copy 201 |
| No-oracle security | TC-14 | cross-user id & missing id → **byte-identical** 404 |
| System read-only | TC-15 | seed PATCH/archive → 403; seed row unmutated |
| PATCH null/kind/AM-1/AM-2 | TC-16, TC-17, TC-18, TC-19 | null clears/omit survives; kind flip 200; kind-only dup 409; self-rename 200 |
| Contract artifacts | TC-20, TC-21 | 3 operations in openapi; both artifacts in-sync & same commit |
| pytest suite | TC-Z1 | Section A green (incl. AM-1/AM-2 update-dedup test) |

**Overall status**: ✅ READY FOR REVIEW (executed 2026-07-24, BASE=http://localhost:8010).

### Final report (executed 2026-07-24)
- **Total: 25 checks** — PC-1…PC-3 (3 preconditions) + TC-1…TC-21 (21) + TC-Z1 (1).
- **Passed: 25** (all green).
- **Failed: 0**.
- **Blocked: 0**.

Precondition results: PC-1 ✅ (health 200, `{"status":"ok","database":"ok"}`),
PC-2 ✅ (psql `SELECT 1` → 1), PC-3 ✅ (regA/regB 201, both tokens non-empty,
`A_ID` UUID).

Highlights / evidence:
- TC-4 ✅ 18 seeds (13 expense / 5 income), `Продукты` shape
  `{is_system:true, icon:"🛒", color:"#4CAF50"}`, order sorted by `(kind,name)`;
  DB seed count 18.
- TC-6 ✅ forced ownership: wire has no `user_id` key (7 keys), stored
  `user_id == A_ID` (bogus `1111…` body value ignored).
- TC-14 ✅ no-oracle: cross-user id and missing id both `404
  {"detail":"CATEGORY_NOT_FOUND"}`, `diff` byte-identical.
- TC-18 ✅ AM-1: kind-only PATCH producing dup pair → 409 CATEGORY_NAME_CONFLICT.
- TC-19 ✅ AM-2: case-only self-rename `Baz`→`baz` → 200 (target row excluded).
- TC-21 ✅ both drift tests green; artifacts modified together in working tree
  (same-commit rule deferred to the actual commit — nothing committed by design).
- TC-Z1 ✅ pytest suite **47 passed, 1 warning** (matches expected 47).

No expectation mismatches between checklist and implementation. The one known
implementation delta (`PATCH {"archived": null}` → 422 `CATEGORY_ARCHIVED_REQUIRED`)
is pytest-covered and required no new TC.
