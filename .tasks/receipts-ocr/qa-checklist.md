# QA Checklist: receipts-ocr (scope 2.1–2.3, 2.5; mobile 2.4 frozen)

**SCOPE QA STRATEGY, mapped by subtask.** This is a *grooming* artifact — a plan.
Nothing is executed now. Each block below is run at the **/test stage of its own
subtask** (S1's checks at S1's /test, etc.), not all at once. This is **Section B
(live, QA-owned)**: it COMPLEMENTS the pytest lists in plan.md (S1 tests 1–3, S2
1–4, S3 1–10, S4 1–7) and never re-asserts them. At each /test I also run the full
pytest suite green (TC-Z1) and do NOT write or fix backend code — a failure is
captured and escalated to senior-lead.

The split rule I applied (per the mandate): pytest owns business logic, validation,
DB-consistency, and both external seams mocked at `app.state.storage` /
`app.state.receipt_parser`. My live layer owns what the mocked-seam suite **cannot
prove**: the real MinIO round-trip, the real Anthropic call, the alembic
lifecycle/CHECK/cascade against a real Postgres, the per-user rate-limit key on a
running server, and the no-oracle security wire bodies.

---

## Claude-dependency test strategy — MY RULING (senior-lead reviews)

**Adopt architecture D10 option (a): one real Anthropic call per S3 /test run, no
cassettes.** Concretely:

1. **Default = mock-at-seam everywhere (pytest owns), PLUS exactly ONE live
   `record_receipt` call** at S3's /test (TC-S3-1) using a real key from the
   environment and one real receipt photo. This is the only thing that proves the
   prompt+tool-schema+image-block+Pydantic-revalidation chain end-to-end against the
   real model. Everything else about the pipeline (claim, taxonomy mapping,
   precedence, guarded UPDATE) is deterministic and stays in pytest with a stub parser.
2. **Reject record/replay (VCR) cassettes** — D10's reasoning holds: vision-request
   cassettes are huge and rot on every prompt/model tweak, giving false confidence.
3. **Nondeterminism discipline:** assert **shape and plausibility, never exact
   values**. Pass = the pipeline reached a terminal state honestly and the payload
   conforms: `status==parsed`, `parsed.total` is a decimal string, `total_minor` is
   a derived int, `items` is a list, `currency` is null-or-3-letter, `suggestion_source`
   ∈ {merchant_map, model, null}, and the GET re-validation did NOT 500. I do NOT
   assert the total equals the receipt's real total or that the merchant string matches.
4. **Pipeline-failure vs model-quality failure — the STOP rule:**
   - *Pipeline reasons* (500 on GET re-validate = schema drift; row stuck in
     `processing` past timeout; `DOWNLOAD_FAILED` on an object that provably exists;
     unhandled exception; wrong JSON shape) → **STOP, escalate to senior-lead.**
   - *Model-quality reasons* (model called `reject_image` on a genuine receipt, or
     transcribed a wrong number, or `INVALID_MODEL_OUTPUT` on a hard photo) → **NOT a
     stop.** Record as honest degradation in the TC actual, note the photo, move on.
     A `failed` receipt with a valid taxonomy code is a *passing* pipeline.
5. **Standing cost guard:** at most **one** guaranteed live call per S3 /test run, on
   **Haiku** (`anthropic_model` default). The optional `NOT_A_RECEIPT` confirmation
   (TC-S3-10) is a second call only at QA discretion — cap total live calls at 2.
   The key is read from the QA shell env only; it is NEVER committed and this live
   call NEVER runs in CI (CI keeps the empty-key mock path).

---

## Preconditions (per subtask; run once at that subtask's /test, keep the shell)

### Environment (shared)
```bash
export BASE=http://localhost:8010                                  # dev API (uvicorn, +10 convention)
export S3=http://localhost:9010                                    # MinIO S3 endpoint (console 9011)
export MC_KEY=minioadmin MC_SECRET=minioadmin BUCKET=receipts
# Live server DB (server reads apps/api/.env → 5443/budget, mirroring 1.3/1.4 /test):
psql_q() { PGPASSWORD=budget psql -h localhost -p 5443 -U budget -d budget -tAc "$1"; }
# Migration/DDL DB (S1 alembic work targets budget_test, NOT the live budget DB):
export ADB='postgresql+asyncpg://budget:budget@localhost:5443/budget_test'
export TDB='postgresql://budget:budget@localhost:5443/budget_test'
export API=/Users/nikitazaretski/work/budget/apps/api
export ROOT=/Users/nikitazaretski/work/budget
```
> **5443 vs 5433 standing rule (carried from 1.2/1.3/1.4):** committed compose maps
> `5433`; the live app + all QA psql/alembic target **5443**. Never edit
> `conftest.py`/`docker-compose.yml` — env-only setup. The `5433` foreign container is
> never touched.

### PC-A — MinIO up + bucket exists (S2/S3) — STOP rule
```bash
curl -s -o /dev/null -w 'minio-live %{http_code}\n' $S3/minio/health/live          # 200
docker compose ps minio minio-init                                                 # minio healthy; minio-init Exited(0)
mc alias set localqa $S3 $MC_KEY $MC_SECRET >/dev/null && mc ls localqa/           # lists "receipts/"
```
- **Expected**: health `200`; `minio` healthy, `minio-init` exited 0; bucket
  `receipts` present. If not → **STOP** (S2/S3 blocked); report to senior-lead.

### PC-B — dev API up on 8010 (S2/S3/S4) — STOP rule
```bash
curl -s -o /dev/null -w '%{http_code}\n' $BASE/health && curl -s $BASE/health       # 200 {"status":"ok","database":"ok"}
```
- Started by QA: `cd $API && uv run uvicorn budget_api.app:create_app --factory --port 8010`
  after confirming `apps/api/.env → …@localhost:5443/budget`. If the live DB is
  pre-`0004`, `alembic upgrade head` (env setup, not a code change). If not 200 → **STOP**.

### PC-C — two users + tokens + ids (S2/S3/S4)
Mirrors 1.3/1.4 PC-3 exactly (form-encoded login, unique per-run emails, capture
`TOKEN_A`, `TOKEN_B`, `A_ID`, `B_ID`, `RUN`). One own category each via `mkcat`
(`A_EXP`, `B_EXP`). STOP if any token/id empty.

### PC-D — ANTHROPIC_API_KEY present **(S3 live check ONLY)**
```bash
[ -n "$ANTHROPIC_API_KEY" ] && echo "key present" || echo "NO KEY"
```
- The dev API for TC-S3-1 (and only that TC) is started with `ANTHROPIC_API_KEY`
  exported and `anthropic_model` at Haiku default. If absent → TC-S3-1/TC-S3-10 are
  ⏸ **blocked** (not failed); the rest of S3 runs with an empty-key server (which is
  itself TC-S3-2). **Question Q4 (below): confirm senior/PM authorizes the one Haiku
  call and supplies the key + a receipt photo fixture.**

### PC-E — receipt photo fixtures (S3 live)
- `/tmp/qa_receipt.jpg` — a real receipt photo, downscaled ~1500px JPEG (mirrors the
  S5 client encode). Supplied by QA/PM.
- `/tmp/qa_not_receipt.jpg` — a non-receipt photo for the optional NOT_A_RECEIPT call.
- `/tmp/qa_big.jpg` — a JPEG **> 10 MiB** for the IMAGE_TOO_LARGE gate
  (`head -c 11000000 /dev/urandom > /tmp/qa_big.bin` also works — HEAD only reads
  Content-Length, content is irrelevant for TC-S3-4).

### Destructive-schema note (S1 Area M)
TC-S1-4 cycles alembic (`downgrade 0003` → re-`upgrade head`) on **budget_test** and
must **own** that DB — run it with **no pytest session active**. The DB is expendable
(migrations rebuild it). Follows the core-data-model Area M precedent.

---

# S1 — infra-and-migration (tier FULL)

*pytest owns (plan S1 1–3): status CHECK via ORM IntegrityError, user-delete cascade
via ORM, composite-PK ON CONFLICT. My live layer owns the alembic lifecycle pytest
skips (`_migrated_schema` only does `upgrade head` + one closing `downgrade base`), the
CHECK/cascade as **migration-produced DDL** (not model metadata), and the endpoint-less
`SET NULL` path.*

### TC-S1-1: compose brings MinIO + one-shot init up; private bucket exists
- **What**: `docker compose up` yields a healthy `minio`, a `minio-init` that exits 0
  after `mc mb --ignore-existing receipts`, and **no anonymous policy** (private).
- **Expected**: PC-A green; `mc anonymous get localqa/$BUCKET` reports access denied /
  no public policy (bucket is private — presigned-only).
- **curl/mc**:
```bash
docker compose up -d minio minio-init
docker compose ps minio minio-init                       # minio healthy; minio-init Exited (0)
mc ls localqa/$BUCKET && echo "bucket ok"
mc anonymous get localqa/$BUCKET 2>&1 | grep -qi 'denied\|no.*policy' && echo "PRIVATE ok"
```
- **Status**: ✅ pass (2026-07-26) — `docker compose up -d minio minio-init`: minio reached **healthy** (`docker inspect`→`healthy`), `minio-init` **Exited(0)** (logs: "Bucket created successfully local/receipts"), health `/minio/health/live`=200. Bucket `receipts` present; `mc anonymous get local/receipts` → `Access permission for local/receipts is private` (explicit private; stronger than the "denied/no policy" grep — adapted assertion, same meaning). **Healthcheck FLAG CLOSED**: `["CMD","mc","ready","local"]` reached healthy, minio-init started and finished — no stuck-container finding. mc run via `docker run --rm --network budget_default --entrypoint /bin/sh minio/mc` (mc absent on host).

### TC-S1-2: `alembic upgrade head` reaches 0004 on real PG (budget_test)
- **Expected**: chain walks `0003 -> 0004`; `alembic current` = `0004 (head)`;
  `alembic check` reports no drift (model↔autogenerate comparable; note the CHECK
  byte-identity is a diff-gate item, `check` does not diff CHECKs — TC-S1-3 proves it live).
- **cmd**:
```bash
cd "$API" && DATABASE_URL="$ADB" uv run alembic upgrade head
DATABASE_URL="$ADB" uv run alembic current                        # 0004 (head)
DATABASE_URL="$ADB" uv run alembic check                          # "No new upgrade operations detected."
psql "$TDB" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_name IN ('receipts','merchant_category_map');"  # 2
psql "$TDB" -tAc "SELECT count(*) FROM information_schema.columns WHERE table_name='transactions' AND column_name IN ('receipt_id','merchant');"  # 2
```
- **Status**: ✅ pass (2026-07-26) — budget_test was at **base** at start (a pytest/other reset since senior-lead's verify), so `upgrade head` walked the full chain `0001→0002→0003→0004` and reached head cleanly. `alembic current`=`0004 (head)`; `alembic check`=`No new upgrade operations detected.`; tables count=**2**; new transactions columns=**2**.

### TC-S1-3: status CHECK is live in the migrated schema (direct psql, not ORM)
- **What**: proves `ck_receipts_status_valid` exists in the **migration-built** table
  and its value set is byte-identical to `ReceiptStatus`. pytest test 1 asserts this via
  the ORM; the DDL-level proof (a raw INSERT bypassing the model) is live-only.
- **Expected**: a raw insert of `status='bogus'` → CHECK violation; each of
  `pending/processing/parsed/failed` accepted.
- **psql**:
```bash
psql "$TDB" -c "INSERT INTO users(id,email,hashed_password) VALUES ('00000000-0000-0000-0000-0000000000e1','qa-s1@x','x');"
psql "$TDB" -c "INSERT INTO receipts(id,user_id,storage_path,status) VALUES (gen_random_uuid(),'00000000-0000-0000-0000-0000000000e1','p','bogus');" 2>&1 | grep -qi 'ck_receipts_status_valid' && echo "CHECK live"
for S in pending processing parsed failed; do
  psql "$TDB" -c "INSERT INTO receipts(id,user_id,storage_path,status) VALUES (gen_random_uuid(),'00000000-0000-0000-0000-0000000000e1','p','$S');" >/dev/null && echo "$S ok"
done
```
- **Status**: ✅ pass (2026-07-26) — raw `INSERT ... status='bogus'` rejected by `ck_receipts_status_valid` (constraint name matched in error). All four valid statuses `pending/processing/parsed/failed` accepted by raw INSERT. Value set is DDL-live and byte-identical to `ReceiptStatus`.

### TC-S1-4: downgrade 0004→0003 is symmetric; re-upgrade is stable (Area M, destructive)
- **What**: pytest never walks the intermediate downgrade. Confirm `downgrade 0003`
  drops `merchant_category_map`, the `fk_transactions_receipts_receipt_id` FK, the
  `merchant`/`receipt_id` columns, `ix_receipts_user_id`, and `receipts` — leaving the
  transactions table clean — then re-`upgrade head` rebuilds identically.
- **Expected**: after `downgrade 0003`: the two new tables gone AND the two new
  transactions columns gone; `current`=`0003`. After re-`upgrade head`: back to `0004`,
  tables/columns present, `alembic check` clean.
- **cmd**:
```bash
cd "$API"
DATABASE_URL="$ADB" uv run alembic downgrade 0003
psql "$TDB" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_name IN ('receipts','merchant_category_map');"   # 0
psql "$TDB" -tAc "SELECT count(*) FROM information_schema.columns WHERE table_name='transactions' AND column_name IN ('receipt_id','merchant');"  # 0
DATABASE_URL="$ADB" uv run alembic current                        # 0003
DATABASE_URL="$ADB" uv run alembic upgrade head                   # rebuild
DATABASE_URL="$ADB" uv run alembic check                          # clean
```
- **Status**: ✅ pass (2026-07-26, destructive, no pytest session active) — `downgrade 0003`: both new tables gone (count=**0**), both transactions columns gone (count=**0**), `current`=`0003`. Re-`upgrade head`: back to `0004`, `check`=`No new upgrade operations detected.`, tables=**2**, columns=**2**. Symmetric + stable. Re-upgraded to head before TC-Z1 so Area M did not race the suite.

### TC-S1-5: user delete cascades receipts + merchant_category_map (DDL cascade, live)
- **What**: pytest test 2 asserts this via ORM; the live psql cascade proves the
  migration's FK `ondelete=CASCADE` (both new tables) — the isolation property the whole
  test suite relies on.
- **Expected**: deleting the user removes its receipt AND its map row (count → 0).
- **psql**:
```bash
U=00000000-0000-0000-0000-0000000000e2; C=$(psql "$TDB" -tAc "SELECT id FROM categories WHERE user_id IS NULL LIMIT 1")
psql "$TDB" -c "INSERT INTO users(id,email,hashed_password) VALUES ('$U','qa-s1c@x','x');"
psql "$TDB" -c "INSERT INTO receipts(id,user_id,storage_path,status) VALUES (gen_random_uuid(),'$U','p','pending');"
psql "$TDB" -c "INSERT INTO merchant_category_map(user_id,merchant_norm,category_id) VALUES ('$U','acme','$C');"
psql "$TDB" -c "DELETE FROM users WHERE id='$U';"
psql "$TDB" -tAc "SELECT (SELECT count(*) FROM receipts WHERE user_id='$U')+(SELECT count(*) FROM merchant_category_map WHERE user_id='$U');"  # 0
```
- **Status**: ✅ pass (2026-07-26) — before `DELETE FROM users`: receipt+map count=**2**; after delete=**0**. Migration FK `ondelete=CASCADE` live on both new tables (user isolation property holds at DDL level).

### TC-S1-6: receipt row delete → `transactions.receipt_id` SET NULL (endpoint-less path)
- **What**: this scope has **no** DELETE /receipts endpoint, so the `ondelete=SET NULL`
  carry-forward FK (1.2) can only be exercised at the DB level. A linked transaction must
  survive with `receipt_id → NULL`, not be deleted.
- **Expected**: after deleting the receipt row, the transaction still exists and its
  `receipt_id` is NULL.
- **psql**:
```bash
U=00000000-0000-0000-0000-0000000000e3; R=$(uuidgen|tr A-F a-f); T=$(uuidgen|tr A-F a-f)
psql "$TDB" -c "INSERT INTO users(id,email,hashed_password) VALUES ('$U','qa-s1n@x','x');"
psql "$TDB" -c "INSERT INTO receipts(id,user_id,storage_path,status) VALUES ('$R','$U','p','pending');"
psql "$TDB" -c "INSERT INTO transactions(id,user_id,amount_minor,kind,currency,occurred_at,receipt_id) VALUES ('$T','$U',100,'expense','RUB','2026-05-01','$R');"
psql "$TDB" -c "DELETE FROM receipts WHERE id='$R';"
psql "$TDB" -tAc "SELECT count(*)=1 AND bool_and(receipt_id IS NULL) FROM transactions WHERE id='$T';"  # t
```
- **Status**: ✅ pass (2026-07-26) — after `DELETE FROM receipts`, the linked transaction **survived** and its `receipt_id` is **NULL** (query → `t`). Carry-forward FK `ondelete=SET NULL` (1.2) live; the endpoint-less path (no DELETE /receipts) exercised at DB level.

---

# S2 — storage-and-receipt-create (tier FULL)

*pytest owns (plan S2 1–4) with a FAKE storage seam: 201 shape/persist, GET pending,
cross-user 404, per-user rate limit. My live layer owns the one thing the fake cannot:
a real presigned round-trip against real MinIO, private-bucket enforcement, the advisory
Content-Type reality (Flag 1), and the rate-limit key on a running server.*

### TC-S2-1: POST /receipts → 201, presigned PUT, row persisted with `{user}/{id}.jpg`
- **Expected**: `201`; `status=="pending"`; `upload.method=="PUT"`;
  `upload.url` points at `$S3` and carries `X-Amz-Signature`/`X-Amz-Expires`;
  `upload.headers` = `{"Content-Type":"image/jpeg"}`; DB row `storage_path == "$A_ID/<id>.jpg"`.
- **curl**:
```bash
R=$(curl -s -X POST $BASE/receipts -H "Authorization: Bearer $TOKEN_A")
echo "$R" | jq '{status, method:.upload.method, headers:.upload.headers, host:(.upload.url|test("localhost:9010"))}'
export RID=$(echo "$R" | jq -r '.id'); export PUT_URL=$(echo "$R" | jq -r '.upload.url')
psql_q "SELECT storage_path='$A_ID/$RID.jpg' FROM receipts WHERE id='$RID'"   # t
```
- **Status**: ✅ pass (2026-07-26) — `201`; `status=="pending"`; `upload.method=="PUT"`; url host `localhost:9010`; `X-Amz-Signature` present + `X-Amz-Expires=600`; `upload.headers=={"Content-Type":"image/jpeg"}`; DB `storage_path=='$A_ID/$RID.jpg'` → `t`. (jq absent on host — used `python3` for JSON; same assertions.)

### TC-S2-2: real PUT of a JPEG to the presigned URL → object lands at `{user}/{id}.jpg`
- **Depends on**: TC-S2-1 (`PUT_URL`, `RID`). The load-bearing round-trip: the API-signed
  host must equal the PUT host (D9 presign-consistency).
- **Expected**: PUT → `200/204`; `mc ls` shows `$A_ID/$RID.jpg` in the bucket.
- **curl/mc**:
```bash
curl -s -o /dev/null -w 'PUT %{http_code}\n' -X PUT "$PUT_URL" \
  -H 'Content-Type: image/jpeg' --data-binary @/tmp/qa_receipt.jpg          # 200/204
mc ls "localqa/$BUCKET/$A_ID/$RID.jpg" && echo "OBJECT LANDED"
```
- **Status**: ✅ pass (2026-07-26) — real PUT (with `Content-Type: image/jpeg`) → `200`; `mc ls` shows `$A_ID/$RID.jpg` (160B) in the bucket. API-signed host (`localhost:9010`) equalled the PUT host → PUT succeeded (D9 presign-consistency holds). `mc` run via `docker run --rm --network budget_default minio/mc` alias `local→http://minio:9000` (host has no `mc`), path adapted `localqa/…`→`local/receipts/…`. Fixture `/tmp/qa_receipt.jpg` = a 160B valid 1×1 JPEG I generated (S2 only needs bytes; parsing is S3).

### TC-S2-3: private bucket — unauthenticated GET without presign → denied
- **What**: no anonymous policy is ever set (D9). A plain GET of the object URL (no SigV4)
  must be refused.
- **Expected**: `403` (AccessDenied), NOT `200`.
- **curl**:
```bash
curl -s -o /dev/null -w '%{http_code}\n' "$S3/$BUCKET/$A_ID/$RID.jpg"        # 403
```
- **Status**: ✅ pass (2026-07-26) — plain GET (no SigV4) → `403` with `<Code>AccessDenied</Code>`, NOT `200`. Private bucket enforced (no anonymous policy).

### TC-S2-4: presign carries a short TTL; expiry is enforced (advisory + optional wait)
- **What**: PUT TTL default 600s, GET/HEAD 300s. Full 600s waits are impractical; assert
  the signed `X-Amz-Expires` matches the configured TTL, and (optional, env-gated) prove
  real expiry with a tiny TTL server.
- **Expected**: `X-Amz-Expires=600` on the create PUT url; `response.upload.expires_at`
  ≈ now+600s. *Optional deep check*: restart the API with
  `s3_presign_put_ttl_seconds=2`, create, wait 3s, PUT → `403` (Request has expired).
- **curl**:
```bash
echo "$PUT_URL" | grep -o 'X-Amz-Expires=[0-9]*'                             # X-Amz-Expires=600
# optional expiry proof (env-gated, only if a short-TTL restart is done):
# sleep 3; curl -s -o /dev/null -w '%{http_code}\n' -X PUT "$SHORT_URL" --data-binary @/tmp/qa_receipt.jpg  # 403
```
- **Status**: ✅ pass (2026-07-26) — create PUT url carries `X-Amz-Expires=600` (matches configured PUT TTL default); `response.upload.expires_at` = signed `X-Amz-Date` + **600.23s** (≈ now+600s, 0.23s clock skew). Optional real-expiry proof (short-TTL restart) NOT run — explicitly optional/env-gated; the advisory `X-Amz-Expires` assertion (the mandatory part) is satisfied, and I avoided an extra API restart beyond the one TC-S2-5 requires.

### TC-S2-5: per-user create rate limit is live and keyed on the USER, not the IP
- **What**: the precedent-setting bit — localhost IP is constant, so a per-IP regression
  would wrongly throttle a second user. Run the API with
  `rate_limit_enabled=True receipt_create_rate_limit="2/minute"`.
- **Expected**: A's 1st/2nd POST `201`, 3rd `429 {"detail":"RATE_LIMITED"}`; **B's** POST
  in the same window `201` (separate key — the regression trap).
- **curl**:
```bash
for i in 1 2 3; do curl -s -o /dev/null -w "A#$i %{http_code}\n" -X POST $BASE/receipts -H "Authorization: Bearer $TOKEN_A"; done  # 201,201,429
curl -s -o /dev/null -w 'B %{http_code}\n' -X POST $BASE/receipts -H "Authorization: Bearer $TOKEN_B"                              # 201
```
- **Status**: ✅ pass (2026-07-26) — API restarted with `RATE_LIMIT_ENABLED=true RECEIPT_CREATE_RATE_LIMIT=2/minute` (pydantic-settings case-insensitive fields `rate_limit_enabled`/`receipt_create_rate_limit`, no env_prefix — confirmed in config.py). A's POST #1/#2 → `201`, #3 → `429 {"detail":"RATE_LIMITED"}`; **B's** POST in the same window → `201`. Both users share the constant localhost IP, so B's 201 proves the limiter keys on the USER, not the IP (the regression trap is closed). Normal server restored afterward (health 200).

### TC-S2-6: GET /receipts/{id} — own pending 200; cross-user 404 no-oracle; auth wall 401
- **What**: the router's one auth test + the no-oracle ownership wire (mirrors 1.3/1.4).
- **Expected**: no token → `401` (status-only); B GETs A's receipt → `404`, and a random
  uuid → `404`, **byte-identical** `{"detail":"RECEIPT_NOT_FOUND"}`; A GETs own pending →
  `200`, `parsed==null`, `suggested_category_id==null`, `suggestion_source==null`.
- **curl**:
```bash
curl -s -o /dev/null -w 'noauth %{http_code}\n' $BASE/receipts/$RID                                   # 401
RAND=$(uuidgen|tr A-F a-f)
curl -s -w '\n%{http_code}\n' $BASE/receipts/$RID  -H "Authorization: Bearer $TOKEN_B" > /tmp/r_x.txt # 404
curl -s -w '\n%{http_code}\n' $BASE/receipts/$RAND -H "Authorization: Bearer $TOKEN_B" > /tmp/r_m.txt # 404
diff /tmp/r_x.txt /tmp/r_m.txt && echo "BYTE-IDENTICAL"
curl -s $BASE/receipts/$RID -H "Authorization: Bearer $TOKEN_A" | jq '{parsed, suggested_category_id, suggestion_source}'  # all null
```
- **Status**: ✅ pass (2026-07-26) — no token → `401`; B GETs A's receipt → `404 {"detail":"RECEIPT_NOT_FOUND"}`; random uuid (as B) → `404 {"detail":"RECEIPT_NOT_FOUND"}`; `diff` of the two full responses (body+code) empty → **BYTE-IDENTICAL** (no-oracle holds). A GETs own pending → `200` with `parsed==null`, `suggested_category_id==null`, `suggestion_source==null`. (jq→python3 for the null check.)

### TC-S2-7: advisory Content-Type reality (Flag 1) — PUT WITHOUT the header still lands
- **What**: minio-py presigned PUT signs `host` only; Content-Type is advisory, NOT
  enforced (plan Flag 1). A PUT that omits/changes the header must still succeed — the
  size cap at parse-HEAD is the real gate. This is inherently live (pytest mocks the seam,
  see Gap G3).
- **Expected**: PUT with no `Content-Type` header → `200/204`, object lands. (Its later
  parse still works because the pipeline base64-sends `media_type=image/jpeg` regardless.)
- **curl**:
```bash
R2=$(curl -s -X POST $BASE/receipts -H "Authorization: Bearer $TOKEN_A"); U2=$(echo "$R2"|jq -r '.upload.url')
curl -s -o /dev/null -w 'noCT %{http_code}\n' -X PUT "$U2" --data-binary @/tmp/qa_receipt.jpg          # 200/204 (not rejected)
```
- **Status**: ✅ pass (2026-07-26) — fresh receipt RID2 created; PUT with **no** `Content-Type` header → `200` (not rejected); `mc ls` shows `$A_ID/$RID2.jpg` (160B) landed. Confirms minio-py presigns `host` only — Content-Type is advisory, not enforced (Flag 1). Gap G3 covered live (pytest mocks the seam).

### TC-S2-8: OpenAPI exposes POST/GET receipts + new components (live == committed)
- **Expected**: `/receipts` has `post`; `/receipts/{receipt_id}` has `get`; components
  include `ReceiptCreated`, `PresignedUpload`, `ReceiptRead`, `ParsedReceiptRead`,
  `ReceiptItem`, `ReceiptError`, `ReceiptStatus`, `SuggestionSource`. Live `/openapi.json`
  == committed `apps/api/openapi.json`; committed `schema.d.ts` drift test green.
- **cmd**: `jq` the two path keys + a `has(...)` over the 8 components on both artifacts;
  run the S2 openapi + client drift tests (mirror 1.4 TC-24).
- **Status**: ✅ pass (2026-07-26) — live `/openapi.json`: `/receipts` has `post`, `/receipts/{receipt_id}` has `get`; all 8 components present (`ReceiptCreated`, `PresignedUpload`, `ReceiptRead`, `ParsedReceiptRead`, `ReceiptItem`, `ReceiptError`, `ReceiptStatus`, `SuggestionSource`). Live == committed `apps/api/openapi.json` → **deep JSON-equal** (used python3 deep-compare, not jq). Generated `packages/api-client/src/generated/schema.d.ts` carries the receipt components (12 refs); drift test authoritative in TC-Z1 (green, 76/76).

---

# S3 — parse-pipeline (tier FULL)

*pytest owns (plan S3 1–10) with BOTH seams mocked: happy parse, 503 gate, NOT_UPLOADED,
TOO_LARGE, ALREADY_PARSED, claim race, stale-loser drop, taxonomy, precedence, rate
limit. My live layer owns the ONE real Anthropic call, the real-MinIO HEAD/GET gates, and
the claim/stale semantics against a real running server + DB.*

### TC-S3-1: LIVE single real Claude parse — the end-to-end proof (see Ruling)
- **Depends on**: PC-D (real key), PC-E (`/tmp/qa_receipt.jpg`), a created+uploaded receipt.
- **What**: the ONLY guaranteed live model call. Create → real PUT → `POST /parse` → poll
  `GET` to terminal. **Assert shape + plausibility, NOT exact values.**
- **Expected (PASS = pipeline honest)**: parse `202` (`status processing`); poll settles to
  `parsed` (or an honest `failed`+valid code = model-quality, still a pass); on `parsed`:
  `parsed.total` a decimal string, `parsed.total_minor` an int, `parsed.items` a list,
  `parsed.currency` null-or-3-letter, `suggestion_source` ∈ {merchant_map,model,null}, and
  the GET did **not** 500 (no schema-drift). **STOP** only on a pipeline reason (500 /
  stuck processing / DOWNLOAD_FAILED on a present object).
- **curl**:
```bash
R=$(curl -s -X POST $BASE/receipts -H "Authorization: Bearer $TOKEN_A"); RID=$(echo "$R"|jq -r .id)
curl -s -o /dev/null -X PUT "$(echo "$R"|jq -r .upload.url)" -H 'Content-Type: image/jpeg' --data-binary @/tmp/qa_receipt.jpg
curl -s -o /dev/null -w 'parse %{http_code}\n' -X POST $BASE/receipts/$RID/parse -H "Authorization: Bearer $TOKEN_A"  # 202
for i in $(seq 1 30); do sleep 2; ST=$(curl -s $BASE/receipts/$RID -H "Authorization: Bearer $TOKEN_A" | jq -r .status); [ "$ST" = parsed -o "$ST" = failed ] && break; done
curl -s $BASE/receipts/$RID -H "Authorization: Bearer $TOKEN_A" | jq '{status, error,
  total_is_str:(.parsed.total|type=="string"), minor_is_int:(.parsed.total_minor|type=="number"),
  items_is_list:(.parsed.items|type=="array"), source:.suggestion_source}'
```
- **Status**: ⏸ pending

### TC-S3-2: AI_NOT_CONFIGURED — empty key fails fast in-request (503), no bg failure
- **What**: API started with `ANTHROPIC_API_KEY=""` (the default). Parse must 503 BEFORE
  any claim/HEAD, and the receipt stays `pending` (never a background `failed`).
- **Expected**: `503 {"detail":"AI_NOT_CONFIGURED"}`; GET still `pending`.
- **curl**:
```bash
# (run against the empty-key server) create+upload a receipt as above -> RID3
curl -s -w '\n%{http_code}\n' -X POST $BASE/receipts/$RID3/parse -H "Authorization: Bearer $TOKEN_A"  # 503 AI_NOT_CONFIGURED
curl -s $BASE/receipts/$RID3 -H "Authorization: Bearer $TOKEN_A" | jq -r .status                      # pending
```
- **Status**: ⏸ pending

### TC-S3-3: RECEIPT_NOT_UPLOADED — parse before any PUT (409, receipt untouched)
- **What**: real-MinIO HEAD 404 before the claim (D5). Create, do NOT upload, parse.
- **Expected**: `409 {"detail":"RECEIPT_NOT_UPLOADED"}`; GET still `pending` (not
  `processing`/`failed` — the claim never ran).
- **curl**: create RID4 (no PUT) → `POST /parse` → 409; `GET` status `pending`.
- **Status**: ⏸ pending

### TC-S3-4: IMAGE_TOO_LARGE — oversized real object (422, receipt untouched)
- **Depends on**: PC-E (`/tmp/qa_big.jpg` > 10 MiB). HEAD Content-Length is the real cap.
- **Expected**: create RID5 → PUT the >10 MiB object → `POST /parse` → `422
  {"detail":"IMAGE_TOO_LARGE"}`; GET still `pending`.
- **curl**: create; `curl -X PUT "$url" --data-binary @/tmp/qa_big.jpg`; parse → 422;
  status pending.
- **Status**: ⏸ pending

### TC-S3-5: double-parse claim — exactly one 202 winner, the other 409 RECEIPT_PROCESSING
- **What**: the money-path idempotency (D5) on a real server. Fire two `POST /parse`
  concurrently on one uploaded receipt (empty-key server is fine — the claim/HEAD run
  before the 503? No: 503 gate is first; so this TC needs the **real-key** server, or a
  server whose parser stub blocks. Live: use the real-key server; the winner spends one
  Haiku call — fold this into the TC-S3-1 run to avoid a 2nd guaranteed call, or accept it
  as part of the one-call budget). Prefer: run against the real-key server, the two racing
  parses share ONE background call.
- **Expected**: of the two responses, exactly one `202` and one `409
  {"detail":"RECEIPT_PROCESSING"}`; the receipt reaches a single terminal state.
- **curl**:
```bash
curl -s -o /tmp/p1 -w '%{http_code}' -X POST $BASE/receipts/$RID/parse -H "Authorization: Bearer $TOKEN_A" &
curl -s -o /tmp/p2 -w '%{http_code}' -X POST $BASE/receipts/$RID/parse -H "Authorization: Bearer $TOKEN_A" &
wait; echo; grep -l RECEIPT_PROCESSING /tmp/p1 /tmp/p2   # exactly one carries the 409 code
```
- **Status**: ⏸ pending

### TC-S3-6: RECEIPT_ALREADY_PARSED — re-parse a parsed receipt → 409 (terminal, no token spend)
- **Depends on**: a `parsed` receipt (reuse TC-S3-1's RID).
- **Expected**: `409 {"detail":"RECEIPT_ALREADY_PARSED"}`; GET still `parsed`, unchanged.
- **curl**: `POST /parse` on the parsed RID → 409.
- **Status**: ⏸ pending

### TC-S3-7: stale-processing takeover after timeout (live DB manipulation)
- **What**: a crashed worker leaves `processing`; after `receipt_parse_stale_seconds` a
  new parse re-claims (D5). Run API with `receipt_parse_stale_seconds=1`; force a stuck row.
- **Expected**: with an uploaded receipt forced to `processing` + an old `parse_started_at`,
  `POST /parse` → `202` (re-claimed, not 409). Contrast: a **fresh** `processing` (recent
  timestamp) → `409 RECEIPT_PROCESSING`.
- **psql/curl**:
```bash
psql_q "UPDATE receipts SET status='processing', parse_started_at=now()-interval '10 minutes' WHERE id='$RID6'"
curl -s -o /dev/null -w 'takeover %{http_code}\n' -X POST $BASE/receipts/$RID6/parse -H "Authorization: Bearer $TOKEN_A"  # 202
psql_q "UPDATE receipts SET status='processing', parse_started_at=now() WHERE id='$RID6'"
curl -s -w '\n%{http_code}\n' -X POST $BASE/receipts/$RID6/parse -H "Authorization: Bearer $TOKEN_A"  # 409 RECEIPT_PROCESSING
```
- **Status**: ⏸ pending

### TC-S3-8: suggestion precedence — seeded merchant_category_map beats the model (map hit)
- **What**: D6 chain, map-over-model, live. Because `merchant` is model-derived and
  nondeterministic, this is a **two-pass** check built on TC-S3-1's observed merchant:
  seed the map for `normalize(observed_merchant)` → a known own category via SQL, then
  parse the SAME photo on a NEW receipt and confirm the suggestion flips to `merchant_map`.
- **Depends on**: TC-S3-1 (observed `parsed.merchant`), a live `merchant_category_map`
  table (S1). Does **NOT** require S4 landed — I seed the normalized key directly via SQL
  (S4's `normalize_merchant` only matters for the write path; here I compute the normalized
  form manually: NFC + casefold + collapse-whitespace). If the observed merchant is null,
  this TC is ⏸ **N/A** (no map key) — noted honestly, not failed.
- **Expected**: after seeding, a fresh parse of the same photo → `suggestion_source ==
  "merchant_map"`, `suggested_category_id == <seeded category>` (map beats any model id).
- **psql/curl**:
```bash
M=$(curl -s $BASE/receipts/$RID -H "Authorization: Bearer $TOKEN_A" | jq -r '.parsed.merchant')
NORM=$(python3 -c "import sys,unicodedata; print(' '.join(unicodedata.normalize('NFC',sys.argv[1]).casefold().split()))" "$M")
psql_q "INSERT INTO merchant_category_map(user_id,merchant_norm,category_id) VALUES ('$A_ID','$NORM','$A_EXP') ON CONFLICT (user_id,merchant_norm) DO UPDATE SET category_id='$A_EXP'"
# create+upload+parse the SAME photo on a new receipt -> RID7, poll to parsed:
curl -s $BASE/receipts/$RID7 -H "Authorization: Bearer $TOKEN_A" | jq '{source:.suggestion_source, cat:.suggested_category_id, expect:"'$A_EXP'"}'  # source merchant_map, cat A_EXP
```
- **Note**: this consumes a 2nd Haiku call (re-parse). Acceptable within the ≤2-call cap;
  or defer the map-hit assertion to pytest test 9 (mocked, deterministic) and keep this
  live TC as a best-effort confirmation. **My ruling: pytest test 9 is authoritative;
  this live TC is best-effort and skipped if the call budget is tight.**
- **Status**: ⏸ pending

### TC-S3-9: parse rate limit — minute window 429 (daily window noted, not exhausted)
- **What**: `receipt_parse_rate_limit="10/minute;100/day"`, per-user. Run API with a tight
  override (`"1/minute;100/day"`) to prove the minute arm live without spending 10 real
  calls; assert the **503 empty-key** or a blocked pre-call path so no real tokens burn
  (the limiter fires before the handler body). Second user not limited (per-user key).
- **Expected**: A's 2nd parse in the window → `429 {"detail":"RATE_LIMITED"}`; B not
  limited. Daily arm: documented as design-verified via pytest + the multi-window string,
  NOT exhausted live (100 real calls is not a sane cost).
- **curl**: two `POST /parse` as A (empty-key server → each would be 503, but the limiter
  wraps the route so the 2nd is 429 before the 503 body) → 2nd 429; B's parse not 429.
- **Status**: ⏸ pending

### TC-S3-10: (OPTIONAL, 2nd live call) NOT_A_RECEIPT via a real non-receipt image
- **What**: confirms the `reject_image` tool path end-to-end. OPTIONAL — pytest test 8
  proves the taxonomy→`error` mapping with a stub; this only confirms the real model
  actually calls `reject_image` on a non-receipt. Costs the 2nd (and last) Haiku call.
- **Expected**: parse `/tmp/qa_not_receipt.jpg` → polls to `status failed`, `error ∈
  {NOT_A_RECEIPT, UNREADABLE_IMAGE}` (either is a **pass** — model's honest judgment). A
  `parsed` result here is a model-quality miss, not a pipeline fail → record, don't STOP.
- **Status**: ⏸ pending

### TC-S3-11: OpenAPI exposes POST /receipts/{id}/parse + populated ReceiptRead; honest 422 anyOf
- **Expected**: `/receipts/{receipt_id}/parse` has `post`; its `422` content is the
  **anyOf union** of `ReceiptError` + `HTTPValidationError` (plan Disagreement 2 / AM-5 —
  the path-param uuid auto-emits the validation arm; declaring `ReceiptError` alone would
  be the lie). GET stays 404-only. Live == committed; drift tests green.
- **cmd**: `jq` the parse `422.content."application/json".schema.anyOf | map(."$ref")` →
  both refs present and unmangled, on live + committed; run S3 openapi/client drift tests.
- **Status**: ⏸ pending

---

# S4 — merchant-learning-and-confirm-fields (tier: senior-lead's call, recommend STANDARD)

*pytest owns (plan S4 1–7): learning upsert, override-wins, no-category guard, cross-user
422, read echoes fields, PATCH-no-learn, normalize unit. My live layer owns the DB-observed
learning after a real POST and the cross-user security wire (the mandate flags it MUST be live).*

### TC-S4-1: confirm learns — POST /transactions with merchant+category writes the map (SQL-observed)
- **What**: the learning hook (D7) observed against the real DB after a real create.
- **Expected**: POST `/transactions` (own category, `merchant:"ACME Store"`) → `201`; a
  `merchant_category_map` row `(A_ID, "acme store") → <that category>` exists, atomic with
  the transaction.
- **curl/psql**:
```bash
curl -s -o /dev/null -X POST $BASE/transactions -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' \
  -d "{\"amount_minor\":500,\"kind\":\"expense\",\"category_id\":\"$A_EXP\",\"occurred_at\":\"2026-05-02\",\"merchant\":\"ACME Store\"}"
psql_q "SELECT category_id='$A_EXP' FROM merchant_category_map WHERE user_id='$A_ID' AND merchant_norm='acme store'"  # t
```
- **Status**: ⏸ pending

### TC-S4-2: override-wins — re-confirm same merchant, new category → map holds the latest
- **Depends on**: TC-S4-1. Post again, `merchant:"acme  STORE"` (whitespace/case variant →
  same norm), `category_id:$A_INC`.
- **Expected**: `201`; map row for `acme store` now → `$A_INC`, `updated_at` refreshed.
- **curl/psql**: second POST; `psql_q "SELECT category_id='$A_INC' FROM merchant_category_map WHERE user_id='$A_ID' AND merchant_norm='acme store'"  # t`
- **Status**: ⏸ pending

### TC-S4-3: cross-user receipt_id → 422 RECEIPT_NOT_FOUND, byte-identical to random (SECURITY, MUST be live)
- **What**: the key ownership assertion (D8) on the wire. B posts a transaction referencing
  **A's** receipt_id → 422 (body-ref, mirrors CATEGORY_NOT_FOUND), indistinguishable from a
  random uuid (no-oracle). A foreign receipt must not be provable to exist.
- **Expected**: both `422 {"detail":"RECEIPT_NOT_FOUND"}`, `diff` empty.
- **curl**:
```bash
RAND=$(uuidgen|tr A-F a-f)
curl -s -w '\n%{http_code}\n' -X POST $BASE/transactions -H "Authorization: Bearer $TOKEN_B" -H 'Content-Type: application/json' \
  -d "{\"amount_minor\":100,\"kind\":\"expense\",\"occurred_at\":\"2026-05-03\",\"receipt_id\":\"$RID\"}"  > /tmp/rf_x.txt  # A's receipt
curl -s -w '\n%{http_code}\n' -X POST $BASE/transactions -H "Authorization: Bearer $TOKEN_B" -H 'Content-Type: application/json' \
  -d "{\"amount_minor\":100,\"kind\":\"expense\",\"occurred_at\":\"2026-05-03\",\"receipt_id\":\"$RAND\"}" > /tmp/rf_m.txt  # random
cat /tmp/rf_x.txt; diff /tmp/rf_x.txt /tmp/rf_m.txt && echo "BYTE-IDENTICAL"
```
- **Status**: ⏸ pending

### TC-S4-4: PATCH does not learn (D7 default NO — contested branch)
- **What**: editing a transaction's category with a merchant present must NOT write/rewrite
  the map. Create tx with `merchant:"Beta Co"` + `$A_EXP` (learns `beta co→A_EXP`), then
  PATCH `{category_id:$A_INC}`.
- **Expected**: `200`; map row for `beta co` **unchanged** (still `$A_EXP`, not `$A_INC`).
- **curl/psql**: create; PATCH; `psql_q "SELECT category_id='$A_EXP' FROM merchant_category_map WHERE user_id='$A_ID' AND merchant_norm='beta co'"  # t (unchanged)`
- **Status**: ⏸ pending

### TC-S4-5: TransactionRead echoes merchant + receipt_id; contract regen (live == committed)
- **What**: the two new nullable read fields (their omission silently breaks S6 prefill) +
  the additive TransactionCreate/Update deltas in the contract.
- **Expected**: a create with `receipt_id`+`merchant` returns both on `TransactionRead`;
  `openapi.json` shows `merchant`/`receipt_id` on TransactionCreate/Update/Read; the new
  422 code `RECEIPT_NOT_FOUND` rides the existing transactions anyOf union (no new
  component). Live == committed; drift tests green.
- **curl/cmd**: create linked tx (own receipt), `jq '{merchant, receipt_id}'`; jq the three
  schemas on both artifacts; run drift tests.
- **Status**: ⏸ pending

---

# S5 / S6 — web (deferred)

**Not my checklist.** S5 (upload/poll) and S6 (confirm-prefill) browser journeys —
dropzone, canvas downscale/EXIF, CORS preflight to MinIO, poll-loop UX, the error-code
message table, currency-mismatch banner — are **web-qa's** at each web subtask's /test
(plan-web §"Test plan" defers them explicitly). My API-level checks above (S2/S3/S4)
underwrite the codes the web maps (`receiptErrorMessage` taxonomy, the 429/409/422/503
arms, `RECEIPT_NOT_FOUND` on create). I do not write web-qa's cases.

---

## TC-Z1 (every subtask /test): full pytest suite green (Section A verification)
Run `cd $API && TEST_DATABASE_URL=…5443/budget_test uv run pytest` (the skill's
`make test`). Confirms backend's mocked-seam tests pass. Any failure → capture, **do NOT
fix backend code**, escalate to senior-lead.

---

## What I explicitly do NOT test (and why)
- **Anything the mocked-seam pytest already proves** — claim-race unit semantics, taxonomy
  code mapping, precedence branches, `model_fields_set` PATCH mechanics, normalize() unit
  cases, composite-PK conflict, ORM cascade. My live TCs exist for real-infra value (real
  MinIO/Anthropic/alembic, no-oracle wire bytes, per-user key on a running server), not to
  re-assert pytest. Overlap is stated where deliberate (e.g. TC-S3-8 defers to pytest 9).
- **Prompt/OCR quality beyond the single live shape+plausibility check** — the model is
  nondeterministic; grading transcription accuracy is not a gate (D10). One honest call.
- **The 100/day rate arm exhausted live** — 100 real calls is not a sane cost; design-
  verified via the multi-window string + pytest; only the minute arm is proven live.
- **Web journeys (S5/S6)** — web-qa owns them.
- **Storage GC / receipt DELETE / receipts LIST** — do not exist in this scope (D1/D12).
- **Presign full 600s expiry wait** — impractical; asserted via `X-Amz-Expires` + an
  optional tiny-TTL env-gated proof.

---

## Gaps / questions for senior-lead (NOT silently expanded into my scope)

- **G1 — `domain/money.py::to_minor_units(total, currency)` ignores its `currency`
  argument** (plan S3 body is always `Decimal(total)*100`, exponent-2 regardless). D10/0.4
  say exponent-2 is the *unknown-currency default*, which implies known currencies use
  their real exponent — and `toInputString` (0.4, web) DOES branch on the currency
  exponent. So the server (always ×100) and the client (per-currency) can disagree for a
  JPY/KWD receipt, and the `currency` param is dead/misleading. Plan says "no minor-units
  test here (tested via the parsed GET)", so the cross-exponent case is untested. **Q: is
  the always-exponent-2 behavior intentional for this scope (with `currency` a documented
  dead param), and is the client/server divergence accepted until 3.2?** If yes, drop the
  param or comment it; add one pytest contrasting a non-exponent-2 currency so the branch
  isn't vacuous.
- **G2 — does `_load_visible_options` (S3 background task) exclude ARCHIVED categories?**
  Two S3 behaviors ride on it: pytest test 9(b) ("map target archived → skipped, model
  wins") and the D6 "unknown/archived model id silently dropped" both require the archived
  category to be **absent** from `visible_ids`. `visible_categories_clause` is the
  own+system visibility predicate; archived-exclusion is a separate filter. If the prompt's
  category list includes archived rows, test 9(b) is vacuous and an archived model
  suggestion would wrongly pass. **Q: confirm the loaded options are filtered
  `archived=false`, and that pytest test 9(b) actually seeds an archived map target that is
  therefore excluded (not just absent).**
- **G3 — advisory-Content-Type (Flag 1) has no pytest coverage** because the parser seam is
  mocked, so "a PUT without/with-wrong Content-Type still parses" can only be shown live.
  I own it as TC-S2-7 (upload lands) + TC-S3-1 (it parses). **Q: confirm senior agrees this
  stays curl-only and is not a plan gap to fill in pytest.** (I believe curl-only is
  correct; flagging so it's a decision, not an omission.)
- **G4 (minor, no action requested) — the background task's own-session-vs-closed-request-
  session correctness** (D11) is only observable via the happy path under ASGITransport
  (pytest test 1). I note it; I don't think it needs a dedicated live TC.

---

## Preconditions & STOP rules summary
| PC | Gate | STOP if |
|---|---|---|
| PC-A | MinIO healthy + `receipts` bucket exists | health ≠ 200 / bucket missing (S2/S3 blocked) |
| PC-B | dev API on 8010, DB round-trip ok | health ≠ 200 (all curl blocked) |
| PC-C | 2 users + tokens + own categories | any token/id empty (downstream blocked) |
| PC-D | ANTHROPIC_API_KEY present | absent → TC-S3-1/10 ⏸ blocked (not failed) |
| PC-E | receipt / non-receipt / oversized fixtures | missing → the fixture-dependent TC ⏸ blocked |

Area M (TC-S1-4) is destructive to **budget_test** schema — run with no pytest session
active; the DB is expendable.

---

## Final report (filled at each subtask's /test)
Per subtask: Total / Passed / Failed (list) / Blocked (list + reason). Any ❌ →
**FAIL OVERALL**, senior-lead handles (I do not fix backend). All green → **READY FOR
REVIEW** for that subtask.

- **S1**: TC-S1-1..6 (+ TC-Z1) — ✅ **READY FOR COMMIT** (executed 2026-07-26). Total 7 / Passed 7 / Failed 0 / Blocked 0. TC-S1-1..6 all ✅; TC-Z1 ✅ (72 passed in 12.18s, matches senior-lead). Healthcheck FLAG CLOSED (minio reached healthy, minio-init exited 0). No backend code / compose / conftest touched. Notes: mc run via `minio/mc` docker image (host has no mc); budget_test was at base at S1-2 start so upgrade walked the full 0001→0004 chain (still reached 0004 head, check clean); TC-S1-1 anonymous assertion adapted (`mc anonymous get`→`...is private`, semantically ≥ the "denied/no policy" grep).
- **S2**: TC-S2-1..8 (+ TC-Z1) — ✅ **READY FOR COMMIT** (executed 2026-07-26). Total 9 / Passed 9 / Failed 0 / Blocked 0. TC-S2-1..8 all ✅; TC-Z1 ✅ (**76 passed** in 13.55s, matches senior-lead's 76/76 diff gate). No backend code / compose / conftest touched. Preconditions: PC-A green (MinIO healthy on 9010, `receipts` bucket private), PC-B green (dev API on 8010, DB round-trip ok, live DB at 0004), PC-C green (2 run-scoped users + tokens + own categories). Adaptations (mechanics only, assertions unchanged): host has no `jq` → used `python3` for JSON parsing/deep-compare; host has no `mc` → `docker run --rm --network budget_default minio/mc` with alias `local→http://minio:9000` (paths `localqa/…`→`local/receipts/…`); `/tmp/qa_receipt.jpg` = a self-generated 160B valid 1×1 JPEG (S2 needs bytes only). TC-S2-4 optional short-TTL expiry proof deliberately not run (explicitly optional/env-gated; advisory `X-Amz-Expires=600` satisfied). TC-S2-5 required the one env-override restart (`RATE_LIMIT_ENABLED=true RECEIPT_CREATE_RATE_LIMIT=2/minute`); normal server restored after. Cleanup: killed the uvicorn I started (port 8010 free); deleted the 2 run-scoped QA users (`qa-s2-%-$RUN@example.com`) → cascaded 5 QA receipts + categories + tokens; removed the 2 QA-uploaded MinIO objects under the QA user prefix. No non-QA rows touched.
- **S3**: TC-S3-1..11 (+ TC-Z1) — status ⏸ pending; **≤2 live Haiku calls/run**.
- **S4**: TC-S4-1..5 (+ TC-Z1) — status ⏸ pending.
</content>
</invoke>
