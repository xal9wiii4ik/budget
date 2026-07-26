# Architecture Plan: receipts-ocr (scope 2.1–2.3, 2.5; mobile 2.4 frozen)

## Context

Photo → presigned upload to local MinIO → BackgroundTask Claude parse → poll →
prefilled confirm → transaction, plus merchant→category learning. This scope
creates the FIRST real `services/` code and the first external integrations
(S3-compatible storage, Anthropic API), so several decisions here set precedent:
the services-layer contract, the seam pattern for external dependencies, and the
per-user rate-limit pattern. Binding PM constraints: localhost-only (MinIO, not
R2 — but R2 swap must be config-only), Anthropic API is the only external call,
web-first, no silent auto-create, scope-grooming output format.

All decisions below are numbered; alternatives and reasoning inline. Open
questions for the PM are collected at the end (Phase 3.5 discipline — nothing
buried). Existing-code references are to real files read during grooming.

---

## D1. `receipts` table

**Decision:**

- `receipts`:
  - `id` Uuid PK, `default=uuid.uuid4`
  - `user_id` Uuid NOT NULL, FK `users.id` `ondelete=CASCADE`, index
    `ix_receipts_user_id` (matches `ix_categories_user_id` precedent; needed for
    the CASCADE path and any future list endpoint — composite with `created_at`
    deferred until a list endpoint exists; recorded no-index verdict for that)
  - `storage_path` String(255) NOT NULL — `{user_id}/{receipt_id}.jpg`, set at
    create time, never mutated
  - `status` String(16) NOT NULL + CHECK
    `status IN ('pending', 'processing', 'parsed', 'failed')` — **varchar+CHECK,
    following the 1.2 precedent** (kind_valid on categories/transactions); a PG
    enum would deviate for no benefit and complicate future value additions.
    CHECK name `ck_receipts_status_valid`, rebuilt from a new
    `ReceiptStatus(StrEnum)` in `enums.py` exactly like `TransactionKind`
    (definition order load-bearing, byte-identical to the migration)
  - `parsed_json` JSONB NULL (`sa.dialects.postgresql.JSONB`) — the model's raw
    validated payload, stored verbatim for auditability. First PG-specific type
    in the schema: acceptable, we are Postgres-only (asyncpg, `~` regex CHECKs
    already PG-specific). Plain `JSON` type rejected: JSONB is the PG norm and
    allows future indexing; TEXT rejected: loses queryability for zero savings
  - `error` String(64) NULL — a stable UPPER_SNAKE machine code from the D10
    failure taxonomy (matches the project-wide `{"detail": CODE}` error-code
    convention; the web client maps codes to human messages). Free-text detail
    deliberately NOT stored — nothing would consume it
  - `parse_started_at` DateTime(timezone=True) NULL — set when a parse claims
    the row; enables stale-`processing` takeover (D5). Naming deliberate: it is
    a claim timestamp, not a generic `updated_at` (the project has no
    `updated_at` convention and this scope doesn't need one)
  - `created_at` DateTime(timezone=True) NOT NULL `server_default=func.now()`
    (transactions precedent)

**Status lifecycle:** `pending → processing → parsed | failed`; `failed →
processing` (re-parse allowed); `processing → processing` allowed only when
`parse_started_at` is older than the stale-claim timeout (D5). `parsed` is
terminal — re-parse of a parsed receipt is 409 (data exists; re-spending Claude
tokens on it has no product value; user creates a new receipt instead).

**Receipt deletion: does not exist in this scope.** No DELETE endpoint. The
`transactions.receipt_id ondelete=SET NULL` is future-proofing required by the
1.2 carry-forward, not a live path. Storage GC for orphaned/failed receipts is
explicitly deferred (localhost MinIO, personal volumes — recorded, not built).

**Receipt→transaction cardinality: 1:N allowed at the DB level** (no unique
constraint on `transactions.receipt_id`). Reasoning: a future "split receipt
into per-item transactions" is plausible and a UNIQUE would need a migration to
undo; the product flow (2.3) creates one transaction per receipt and disables
the confirm button after success. Double-confirm double-submit risk is identical
to the existing plain POST /transactions double-click (no idempotency there
either) — consistent, not new exposure.

## D2. Same migration: `transactions.receipt_id` (+ `merchant`) and `merchant_category_map`

**Decision:** one migration `0004` (pure DDL, mirroring the 0002/0003 split —
no seed data exists in this scope so no 0005) containing:

1. `receipts` table (D1)
2. `transactions.receipt_id` Uuid NULL, FK `receipts.id` `ondelete=SET NULL`
   — **BINDING 1.2 carry-forward, same migration as `receipts`**. FK name per
   naming convention: `fk_transactions_receipts_receipt_id`. No index on
   `receipt_id` (recorded verdict: only lookup shape is "transactions for
   receipt X", which this scope never queries; revisit with receipt deletion or
   split-flow)
3. `transactions.merchant` String(255) NULL — see D8 for reasoning and the PM
   veto point. If the PM vetoes storage, this column drops from the migration
   and `merchant` stays a transient request field
4. `merchant_category_map` (D3)

Downgrade fully symmetric (drop in reverse order), like 0002.

## D3. `merchant_category_map` table

**Decision:**

- `merchant_category_map`:
  - `user_id` Uuid NOT NULL, FK `users.id` `ondelete=CASCADE`
  - `merchant_norm` String(255) NOT NULL — the NORMALIZED merchant key (D4)
  - PK: **composite (`user_id`, `merchant_norm`)** — natural key, no surrogate
    id (profiles precedent: natural PK). A surrogate id + UNIQUE rejected: the
    pair IS the identity, and the composite PK is exactly the upsert target
    (`ON CONFLICT (user_id, merchant_norm) DO UPDATE`)
  - `category_id` Uuid NOT NULL, FK `categories.id` `ondelete=CASCADE` — a map
    entry without a category is meaningless, so CASCADE not SET NULL.
    (Categories are archive-only today — this FK path is dormant safety.)
  - `updated_at` DateTime(timezone=True) NOT NULL `server_default=func.now()`,
    updated by the upsert — cheap, makes "last confirmation wins" auditable.
    No `created_at` (adds nothing over `updated_at` here)

Archived-category handling is read-side, not write-side: an entry pointing at a
since-archived category is skipped at suggestion time (D6), not deleted.

## D4. Merchant normalization — `domain/merchant.py`

**Decision:** pure function `normalize_merchant(raw: str) -> str` in
`domain/merchant.py` (first real `domain/` code — pure logic, zero imports,
unit-testable, exactly what §4 designed the layer for). Rule: NFC-normalize,
`str.casefold()`, strip, collapse internal whitespace runs to single spaces.
Empty result after normalization ⇒ treat as "no merchant" (no map write, no
lookup). Both the learning write path (D7) and the suggestion read path (D6)
call this one function — normalization lives in exactly one place. No
fuzzy/prefix matching (speculative; exact-match on normalized string is the
minimal interpretation — recorded as a future trigger if real-world merchant
strings prove too noisy).

## D5. Parse claim, idempotency, and stale takeover

**Decision:** the claim happens **synchronously in the POST /receipts/{id}/parse
handler**, not in the background task, via one atomic UPDATE:

```
UPDATE receipts SET status='processing', parse_started_at=now(), error=NULL
WHERE id=:id AND user_id=:me
  AND (status IN ('pending','failed')
       OR (status='processing' AND parse_started_at < now() - :stale_timeout))
```

- rowcount 1 ⇒ claim won, schedule the BackgroundTask, return 202
- rowcount 0 ⇒ re-select to distinguish: missing/foreign ⇒ 404
  `RECEIPT_NOT_FOUND` (no-oracle, `_load_own` pattern); `parsed` ⇒ 409
  `RECEIPT_ALREADY_PARSED`; fresh `processing` ⇒ 409 `RECEIPT_PROCESSING`

This makes double-clicks and racing tabs spend Claude tokens at most once, and
a crashed worker (row stuck in `processing`) self-heals after
`receipt_parse_stale_seconds` (default 300s — comfortably above the total
pipeline timeout in D10, so a live parse can't be double-claimed).
Alternatives rejected: tolerating double-parse (double token spend on the money
path — cheapest bug to prevent, one UPDATE); a separate claim state machine
module (overkill for one table).

**Object-existence check:** also synchronous in the parse handler — an async
`httpx` HEAD against a presigned HEAD URL (SigV4 signs the method, so a
GET-presign cannot be HEAD-ed; the storage service presigns per-method, D9).
Missing object ⇒ 409 `RECEIPT_NOT_UPLOADED` **before** the claim UPDATE, so the
receipt stays `pending`/`failed` and the client can upload and retry.
Content-Length from the same HEAD enforces the size cap (D11): over-cap ⇒ 422
`IMAGE_TOO_LARGE` (receipt untouched; client downscales properly and creates a
new receipt). Doing this in-request (one fast localhost roundtrip) gives the
client an immediate, actionable error instead of a poll-discovered failure.

## D6. Suggestion precedence — server-side, resolved at parse completion

**Decision:** the final suggestion is a **server** decision, computed **once, in
the background task at parse completion**, and stored on the receipt row's
response projection (derived at serialization from stored fields — see below).
Chain, first hit wins:

1. `merchant_category_map[user_id, normalize_merchant(parsed.merchant)]` — IF
   the entry's category is still visible and not archived (checked against the
   same visible-category list already loaded for the prompt — no extra query)
2. Claude's `suggested_category_id` — IF it is in the visible category list
   sent in the prompt (membership check against the in-memory list; this IS the
   reuse of the `category_access.py` visibility definition — the list itself is
   loaded via `visible_categories_clause`). An unknown/archived id from the
   model is NOT an error: it is silently dropped (model noise, not a failure)
3. null (user picks manually)

Map-over-Claude reasoning: map entries come from the user's own confirmed
choices — that is what "manual override wins" concretely means at prefill time.

Storage shape: `parsed_json` keeps the model's payload verbatim (including its
raw `suggested_category_id`). The resolved suggestion is exposed on the wire as
`suggested_category_id` + `suggestion_source: "merchant_map" | "model" | null`
(GET /receipts/{id}, D12) — computed in the background task and stored in
`parsed_json` under a reserved `_resolved` key? **No** — cleaner: two nullable
columns would pollute the table for derived data; instead the task stores the
resolved pair alongside the model payload inside `parsed_json`
(`{"model": {...}, "suggested_category_id": ..., "suggestion_source": ...}`).
One JSONB document, one write, GET is a pure read (polling stays cheap, no
per-poll map lookup). Freshness trade-off accepted: a map entry learned AFTER
this receipt parsed doesn't retroactively update its suggestion — irrelevant in
practice (receipts are confirmed within minutes of parsing).

## D7. Learning hook — inside POST /transactions

**Decision:** learning is part of the existing transaction write path
(reuse-existing-operation gate, D8): when a POST /transactions payload carries
non-empty `merchant` AND non-null `category_id`, the handler upserts
`merchant_category_map (user_id, normalize_merchant(merchant)) → category_id`
(`ON CONFLICT DO UPDATE SET category_id=excluded.category_id,
updated_at=now()`), in the same session/commit as the transaction insert
(atomic — a learned pair never exists without its transaction).

- **Always upsert, even when the confirmed category equals the suggestion.**
  "Manual override wins" falls out for free: whatever the user confirms is by
  definition their latest manual choice; equal-value upserts are harmless
  refreshes of `updated_at`. A differs-from-suggestion condition rejected: it
  would require threading the suggestion through the confirm payload for zero
  behavioral difference.
- Learning also fires for manual (non-receipt) transactions that carry a
  merchant — feature, not bug (consistent semantics; today's web form simply
  won't send merchant for manual entry).
- PATCH /transactions does NOT learn (minimal interpretation; a category edit
  on an old transaction re-teaching the map is plausible but unconfirmed intent
  — recorded as an open question, default NO).

## D8. Confirm = POST /transactions, generalized (no new endpoint)

**Decision:** NO `/receipts/{id}/confirm` endpoint. The confirm step is the
existing `POST /transactions` with two additive optional fields on
`TransactionCreate`:

- `receipt_id: uuid.UUID | None = None` — validated as **own receipt**
  (user_id-scoped load, one code path; foreign/missing ⇒ 422
  `RECEIPT_NOT_FOUND`, mirroring the body-ref `CATEGORY_NOT_FOUND` precedent
  exactly: the addressed resource is fine, the body reference is the 422). No
  status requirement (linking a pending/failed receipt is pointless but
  harmless; enforcing `parsed` adds a rule nothing needs)
- `merchant: str | None = None` — trimmed, capped at 255 (validator mirroring
  `_clean_note`); drives learning (D7) and is stored on the row (D2.3, PM veto
  point below)

Reasoning (reuse-existing-operation gate): the confirm action IS "create a
transaction" — same validation (category visibility, amount ≥ 1, kind
required), same serializer, same client mutation path (1.6 web already has this
mutation wired with cache invalidation). A parallel confirm endpoint would
duplicate all of it and create a second write path to keep consistent forever.
`TransactionUpdate` also gains `merchant` (PATCH can fix a typo'd merchant;
explicit null clears) but NOT `receipt_id` (re-linking receipts is not a flow;
minimal). `TransactionRead` gains both fields (nullable).

**`GET /transactions/{id}` is NOT added.** Checked against the 1.4 trigger: the
confirm flow prefills from the receipt payload and creates via POST — it never
needs an out-of-cache single transaction read. Trigger stands for later.

**Currency gap (flagged, deferred):** parsed receipts carry a currency, but
`TransactionCreate` has no currency field — the server stamps
`profile.base_currency` (1.4 decision d; stage 3.2 adds multi-currency). A
receipt in a foreign currency therefore confirms as a base-currency amount.
Scope ruling: 2.3 web shows the parsed currency and warns when it differs from
the base currency (the client knows base currency from the summary response);
the amount field is editable. Pulling stage-3 currency work into this scope is
rejected — recorded as the existing 3.2 trigger closing this window.

## D9. Storage service — `services/storage.py`

**Decision:** class `Storage` constructed from `Settings` in `create_app`,
stored on `app.state.storage` (the sessionmaker precedent), consumed by the
receipts router via `request.app.state`. Narrow surface:

- `object_path(user_id, receipt_id) -> str` — `{user_id}/{receipt_id}.jpg`
- `presign_put(path) -> PresignedRequest` (url + headers incl. enforced
  `Content-Type: image/jpeg`, TTL `s3_presign_put_ttl_seconds`, default 600)
- `presign_get(path)` / `presign_head(path)` — TTL
  `s3_presign_get_ttl_seconds`, default 300 (per-method presign; SigV4 signs
  the verb)

**Client library: `minio` (minio-py) for signing only; `httpx` for all actual
I/O.** Reasoning: presigning is pure local computation (no network, no
blocking) — safe to call synchronously inside async handlers, so the async
story of the SDK is irrelevant if the SDK never touches the network. The two
network operations the API performs (HEAD in the parse handler, GET in the
background task) go through async `httpx` (already in the dependency closure —
the `anthropic` SDK depends on it; it moves from dev to a main dependency).
Alternatives rejected: `aioboto3` (fully async but drags
boto3+botocore+aiobotocore with chronic version-pinning friction — heavy for
"sign a URL"); `boto3` (same weight, sync network calls would block the loop or
need `to_thread` — and ruff's ASYNC ruleset is active); hand-rolled SigV4
(never). minio-py is light (urllib3 only) and speaks any S3-compatible
endpoint. **R2 swap is config-only**: endpoint/keys/region/bucket all come from
env; nothing MinIO-specific in code.

**Bucket creation: compose-side, not app-side.** A one-shot `minio/mc` init
service in docker-compose creates the private bucket idempotently
(`mc mb --ignore-existing`). The API never creates buckets — keeps startup
clean, keeps tests that don't touch storage from needing MinIO, and matches how
R2 would work (bucket pre-exists). No anonymous policy is ever set — private
bucket, presigned URLs only (architecture §3).

**docker-compose (root file; backend-engineer owns the edit):**

- `minio`: pinned `minio/minio:RELEASE.*` tag, `server /data
  --console-address ":9001"`, `MINIO_ROOT_USER/PASSWORD=minioadmin` (localhost
  dev only), ports **`9010:9000` (S3) / `9011:9001` (console)** — the project's
  established +10 offset convention (API 8010, PG 5433/5443), avoiding the
  default 9000/9001 that other local stacks commonly squat; volume
  `budget_minio_data:/data`; healthcheck `mc ready local` (or the
  `/minio/health/live` curl)
- `minio-init`: one-shot `minio/mc` depends_on minio healthy, creates bucket
  `receipts`

**Presign host consistency (load-bearing):** the signature covers the host, so
the URL the browser PUTs to must be the URL the API signed.
`s3_endpoint_url=http://localhost:9010` works for both because the API runs on
the host (uvicorn :8010), not in compose. If the API is ever containerized, a
split public/internal endpoint pair becomes necessary — recorded as a deploy
trigger, NOT built now (no speculative knob). Browser PUT CORS: MinIO defaults
to `*` for the S3 API (`MINIO_API_CORS_ALLOW_ORIGIN` unset) — no config needed;
recorded so nobody "fixes" it blindly.

**Test strategy recommendation (QA decides finally):** router/unit tests
substitute `app.state.storage` with a fake (the seam is the class surface
above); one integration test module runs against compose MinIO, skipped when
unreachable. moto rejected: it emulates AWS via boto — wrong shape for a
minio-py+httpx stack, and real MinIO is already one `docker compose up` away.

## D10. Claude parse service — `services/receipt_parser.py`

**Decision:** class `ReceiptParser` constructed from `Settings` in
`create_app`, stored on `app.state.receipt_parser` — the substitution seam for
QA (fake parser = assign a stub object; no monkeypatching internals). Surface:

```
async def parse(self, image_jpeg: bytes, categories: Sequence[CategoryOption])
    -> ParsedReceipt   # raises ReceiptParseError(code=...)
```

`CategoryOption` = frozen (id, name, kind) triple — the service NEVER imports
models or touches the DB; the caller (background task) loads visible categories
via `visible_categories_clause` (reuse gate: the one visibility predicate) and
maps rows to options. The 18 frozen system UUIDs arrive through this same list
(1.2 carry-forward: stable across environments, safe to appear in prompts).

- SDK: `anthropic` `AsyncAnthropic` (async client; explicit
  `timeout=receipt_parse_timeout_seconds`, default 90, `max_retries=1`)
- Model: config `anthropic_model`, **default Haiku 4.5** (vision-capable,
  cheapest adequate tier for receipt OCR; exact model-id string pinned by
  backend-engineer from current SDK docs at implementation). Escalate to Sonnet
  4.5 via env if quality disappoints — config-only swap
- `max_tokens=2048` (long item lists fit; hard ceiling on spend)
- Image: single base64 `image` content block, `media_type: image/jpeg`
  (upload contract fixes jpeg, D11)
- **JSON forcing: forced tool-use, two tools, `tool_choice={"type": "any"}`:**
  - `record_receipt` — input_schema mirroring `ParsedReceipt` (below)
  - `reject_image(reason: enum["not_a_receipt", "unreadable"])` — the model's
    structured escape hatch for non-receipt/illegible images
  Text-mode + `json.loads` rejected: brace-hunting and markdown-fence stripping
  is exactly the fragility tool-use exists to eliminate; tool input arrives as
  parsed JSON conforming to the schema. Two tools beat one schema-with-optional-
  everything: the success schema stays strict while rejection stays expressible.
- **`ParsedReceipt` (Pydantic, in `schemas/receipt.py`):**
  - `total: str` — decimal string as printed (e.g. `"1234.56"`); converted
    server-side to `total_minor: int` with exponent-2 default for unknown
    currencies (the 0.4 `toInputString` decision, mirrored server-side; the two
    stay consistent by construction). Asking the model for minor units
    rejected — models botch cents-multiplication more than transcription
  - `currency: str | None` — 3-letter uppercase or null
  - `merchant: str | None`
  - `date: date | None` (`YYYY-MM-DD`)
  - `items: list[ReceiptItem]` (`name: str`, `amount: str | None`) — stored and
    returned for display; NOT used by the confirm flow in this scope (one
    transaction per receipt; split-by-item is a recorded future, not built)
  - `suggested_category_id: uuid.UUID | None` — validated per D6 step 2
- **Failure taxonomy → `receipts.error` code:**
  - `NOT_A_RECEIPT` — model called `reject_image` (reason folded into the code:
    `UNREADABLE_IMAGE` for the second enum value)
  - `INVALID_MODEL_OUTPUT` — tool input failed Pydantic validation (after one
    in-service retry? NO — minimal: no auto-retry, user re-parses; recorded)
  - `ANTHROPIC_ERROR` — API/network/timeout/refusal-without-tool
  - `DOWNLOAD_FAILED` — storage GET failed in the task (object vanished between
    HEAD and GET, MinIO down)
  - (`IMAGE_TOO_LARGE`, `RECEIPT_NOT_UPLOADED` never reach `error` — they are
    synchronous request-time rejections, D5)
  An unknown `suggested_category_id` is NOT in this taxonomy — dropped
  silently per D6.
- `anthropic_api_key: str = ""` in Settings (empty default keeps every existing
  explicit `Settings(...)` construction site — openapi_export, tests — working;
  localhost-only scope). The parse handler returns **503 `AI_NOT_CONFIGURED`**
  when the key is empty — fail fast in-request, never a background failure.

**Test strategy recommendation (QA decides finally):** mock at the
`app.state.receipt_parser` seam for all pipeline/router tests (deterministic,
free); optionally one opt-in "tiny real call" marked test behind an env flag
for prompt-contract smoke. Record/replay (VCR) rejected as the default:
cassettes of vision requests are huge and rot with model/prompt changes.

## D11. Pipeline mechanics (BackgroundTasks)

**Decision:**

- **Session handling:** the background task NEVER reuses the request session
  (closed when the response returns — `get_session` yields per-request). The
  task receives `request.app.state.sessionmaker` (+ `storage`, `receipt_parser`,
  `settings`) captured at schedule time and opens its own
  `async with sessionmaker() as session` — same loop, same engine, the pattern
  db.py already supports. FastAPI BackgroundTasks stays (architecture §6: arq/
  Celery is the recorded growth trigger, not this scope).
- **Task body** (module-level function in `routers/receipts.py` — see D13 for
  the layering ruling), fully exception-guarded (a background task must never
  raise):
  1. GET image via presigned URL (httpx, 30s timeout) — failure ⇒ `failed` /
     `DOWNLOAD_FAILED`
  2. Load visible categories (one query, `visible_categories_clause`)
  3. `receipt_parser.parse(...)` — `ReceiptParseError.code` ⇒ `failed` + code
  4. Resolve suggestion (D6: map lookup on normalized merchant, one PK-lookup
     query; validate against loaded list)
  5. Single terminal UPDATE: `status='parsed'`, `parsed_json={model, 
     suggested_category_id, suggestion_source}`, `error=NULL` — guarded
     `WHERE status='processing' AND parse_started_at=<my claim>` so a stale
     worker that lost its claim to a takeover (D5) cannot clobber the winner
     (claim token = the `parse_started_at` value this worker wrote; rowcount 0
     ⇒ silently drop own result)
- **Size cap:** `receipt_max_bytes` default 10 MiB, enforced via the
  synchronous HEAD's Content-Length (D5). Presigned-PUT cannot enforce a size
  cap (SigV4 PUT signs headers, not a length range); presigned POST policies
  can (`content-length-range`) but complicate the client to enforce a limit the
  HEAD check already enforces one step later. Recorded alternative if abuse
  ever matters (it can't: localhost, own users).
- **Rate limit:** slowapi on POST /receipts/{id}/parse (the money endpoint) AND
  POST /receipts (prevents unbounded object creation), reusing rate_limit.py's
  AM-C machinery: receipts router mounts with `Depends(prime_rate_limit)` (the
  auth-router precedent), new Settings knobs `receipt_create_rate_limit:
  str = "30/minute"` and `receipt_parse_rate_limit: str = "10/minute;100/day"`
  (limits-lib multi-window string — the architecture-§3 daily AI cap and a
  burst cap in one knob). **Per-user key, not per-IP** (localhost IP is
  constant; the cost driver is the account): a small router-level dependency
  stashes `user.id` on `request.state`, and the parse routes pass a per-route
  `key_func` (slowapi supports per-decorator key_func) that keys on
  `{scope}:{user_id}`. Falls back to remote address if unauthenticated (never
  happens post-auth-dep, belt-and-suspenders).

## D12. API contract — receipts router (`routers/receipts.py`, prefix `/receipts`)

**Decision — lean typed DTOs everywhere; `parsed_json` is NEVER returned
verbatim** (the wire shape is `ParsedReceipt`, re-validated from the stored
document at read time — a DB document that drifted from the schema is a 500,
loudly, not silently-shipped junk). Error envelope: `{"detail": CODE}` /
`ReceiptError` model, mirroring `TransactionError`.

- `POST /receipts` → 201 `ReceiptCreated`:
  `{id, status: "pending", upload: {url, method: "PUT", headers:
  {"Content-Type": "image/jpeg"}, expires_at}}` — no request body (content type
  fixed to jpeg by contract; the 2.3 web downscale re-encodes canvas→JPEG, so
  PNG screenshots become jpeg client-side; a `content_type` request field is
  speculative until a client can't transcode). Rate-limited (D11); 429
  `RATE_LIMITED` per the shared handler.
- `POST /receipts/{id}/parse` → 202 `ReceiptRead` (status `processing`).
  Errors: 404 `RECEIPT_NOT_FOUND`, 409 `RECEIPT_ALREADY_PARSED` /
  `RECEIPT_PROCESSING` / `RECEIPT_NOT_UPLOADED`, 422 `IMAGE_TOO_LARGE`,
  503 `AI_NOT_CONFIGURED`, 429 `RATE_LIMITED` (all declared honestly in
  `responses=` per the AM-5 precedent where a route mixes business codes with
  Pydantic 422s — here 422 has only the business arm, `ReceiptError` alone).
- `GET /receipts/{id}` → 200 `ReceiptRead`:
  `{id, status, parsed: ParsedReceiptRead | null, suggested_category_id:
  uuid | null, suggestion_source: "merchant_map" | "model" | null,
  error: str | null, created_at}` where `ParsedReceiptRead` =
  `{total, total_minor, currency, merchant, date, items[]}`. 404
  `RECEIPT_NOT_FOUND` (no-oracle). Polling contract: client polls every 2s
  while `pending`/`processing`, gives up with a retry affordance after ~60s
  (client-side; no server timeout endpoint). No SSE — 0.3 carry-forward,
  polling only.
- **No `GET /receipts` list, no `DELETE /receipts/{id}`** in this scope
  (nothing in 2.3 renders a receipt list; deletion ruled out in D1).
- Route ordering: `/receipts` has no literal-vs-param collision (only `/{id}`
  and `/{id}/parse`); the 1.4 rule (`/transactions/summary` before `/{id}`) is
  untouched because no transactions route is added.

## D13. Module structure & dependency direction (precedent-setting)

**Decision — the services-layer rule this scope establishes:**

- `services/` = **stateless external-integration clients**: constructed from
  `Settings`, no DB session, no `models` imports, no router imports, no
  `db.py` imports. `services/storage.py` and `services/receipt_parser.py` both
  comply (bytes/paths/DTOs in, DTOs/URLs out). Wired once in `create_app`,
  carried on `app.state` (the sessionmaker/limiter precedent), reached via
  `request.app.state` — no module-level singletons, per-app test substitution
  for free.
- `domain/` = pure functions, zero internal imports beyond stdlib
  (`domain/merchant.py`).
- Orchestration (the background task: session + storage + parser + models)
  lives in `routers/receipts.py` next to its only trigger — the 1.2/1.4
  first-consumer precedent ("aggregate SQL sits with its router; the second
  consumer extracts"). When a scheduler or second entry point needs the
  pipeline, THAT task extracts it to a `services/receipt_pipeline.py`-style
  orchestrator — recorded trigger, not built.
- Direction: `routers → {services, domain, models, category_access, schemas}`;
  `services → config/schemas only`; `domain → nothing`. `enums.py` gains
  `ReceiptStatus` (neutral module, both models and schemas import it —
  existing pattern).
- `_get_or_create_profile` extraction trigger (1.4): NOT fired — confirm reuses
  POST /transactions, which is still the only profile-reading consumer. No new
  consumer appears in this scope. Recorded.
- New runtime deps in `apps/api/pyproject.toml`: `anthropic`, `minio`, `httpx`
  (promoted from dev group). Nothing else.

## D14. Suggested subtask split (input to backend/web plans; engineers own final)

| # | Subtask | Contents | Depends on | Suggested tier |
|---|---------|----------|-----------|----------------|
| S1 | `infra-and-migration` | docker-compose MinIO + mc-init; migration 0004 (receipts, merchant_category_map, transactions.receipt_id [+merchant]); models + `ReceiptStatus`; conftest cleanup check (CASCADE graph still row-delete-clean) | — | FULL |
| S2 | `storage-and-receipt-create` | `services/storage.py` + Settings S3 surface; `POST /receipts`, `GET /receipts/{id}` (pending-only path); rate limit on create; contract regen | S1 | FULL |
| S3 | `parse-pipeline` | `services/receipt_parser.py`; `POST /receipts/{id}/parse` (claim, HEAD checks, 503 gate, per-user rate limit); background task incl. D6 suggestion resolution (map read); GET now returns parsed/failed; contract regen | S2 | FULL |
| S4 | `merchant-learning-and-confirm-fields` | `domain/merchant.py`; `TransactionCreate/Update/Read` merchant+receipt_id fields, receipt-ref validation, upsert learning; contract regen | S1 (parallel with S3; S3's map-read hits an empty table until this lands — harmless) | senior-lead's call (PM deferred) |
| S5 | `web-upload-and-poll` | dropzone/input, canvas downscale ~1500px→JPEG, create→PUT→parse→poll loop, error-code UX (incl. 429/failed taxonomy) | S3 | STANDARD |
| S6 | `web-confirm-prefill` | prefilled transaction form (toInputString on total, suggested category, date, merchant), currency-mismatch warning, submit via existing create mutation + receipt_id/merchant, cache invalidation per 1.6 obligations | S4, S5 | STANDARD |

Order: S1 → S2 → S3 → (S4 ∥ S3) → S5 → S6.

---

## Open questions for PM (either/or, with recommendations — none block S1/S2)

1. **Store `merchant` on `transactions` (nullable column, D2.3) vs transient
   confirm-payload-only field?** Recommend **store**: the learning pair should
   be auditable against real rows, stage-4 "топ-мерчанты" statistics need it
   (JSONB-mining receipts misses manual entries), and it is one nullable column
   in a migration we're writing anyway. Veto ⇒ drop the column; learning still
   works.
2. **Re-parse of a `parsed` receipt: 409 (recommended) vs allowed re-spend?**
   Recommend **409 `RECEIPT_ALREADY_PARSED`** — parsed data exists; re-parsing
   costs tokens for no product value; a bad photo means a new receipt.
3. **PATCH /transactions category edits re-teach the merchant map?** Recommend
   **NO** (unconfirmed intent, minimal interpretation): only confirm-time
   (create) writes learn. Veto ⇒ one extra upsert in PATCH.
4. **Model default: Haiku 4.5 (recommended, cheap) vs Sonnet 4.5 (better OCR on
   ugly receipts)?** Config-only either way (`ANTHROPIC_MODEL`).
5. **Foreign-currency receipts confirm as base-currency amounts until stage 3.2
   (recommended: accept + web warning) vs pulling currency-on-create into this
   scope?** Recommend **defer** — 3.2 is the recorded owner and the create
   contract change there is additive.
6. **Failed-parse retry limit: none (recommended — rate limit already caps
   daily spend at 100/day/user) vs a per-receipt attempt cap?** Recommend
   **none**; the `10/minute;100/day` per-user limit is the spend guard.
7. **Items[] are parsed/stored/displayed but confirm creates ONE transaction
   (recommended, per architecture doc) — split-by-item is out of scope.**
   Confirming scope boundary, not asking to build it.

## Contract changes (every OpenAPI-visible delta; each forces client regen)

New (receipts router, tag `receipts`):
- `POST /receipts` → 201 `ReceiptCreated` (id, status, upload{url, method,
  headers, expires_at}); 429
- `POST /receipts/{id}/parse` → 202 `ReceiptRead`; 404/409/422/429/503
  (`ReceiptError` envelope)
- `GET /receipts/{id}` → 200 `ReceiptRead` (id, status, parsed:
  `ParsedReceiptRead`|null, suggested_category_id, suggestion_source, error,
  created_at); 404

New components: `ReceiptCreated`, `ReceiptRead`, `ParsedReceiptRead`,
`ReceiptItem`, `ReceiptError`, `ReceiptStatus` enum
(`pending|processing|parsed|failed`), `SuggestionSource` enum.

Changed (transactions):
- `TransactionCreate`: + `receipt_id?: uuid|null`, + `merchant?: string|null`
  (additive, backward-compatible)
- `TransactionUpdate`: + `merchant?: string|null` (additive)
- `TransactionRead`: + `receipt_id: uuid|null`, + `merchant: string|null`
  (additive; 1.6 web list rendering unaffected but types regen)
- New 422 business code on create: `RECEIPT_NOT_FOUND` (existing AM-5 anyOf
  union already covers the shape)

Process: `openapi.json` + `schema.d.ts` regenerate and commit together in every
subtask that touches the contract (S2, S3, S4).

## What this does NOT decide (left to engineers)

- Exact Alembic op ordering/naming inside 0004 (convention is mechanical),
  exact minio-py call signatures, mc-init one-liner.
- Prompt wording (the CONTRACT is D10's tool schemas + category-list injection;
  the prose is backend-engineer's, iterated under QA's seam tests).
- Exact model-id string for Haiku 4.5; httpx timeout fine-tuning.
- Web component structure, poll-loop hook shape, dropzone library-or-not,
  downscale quality factor (plan-web.md; 1.6 obligations apply).
- Final test strategy for storage and Claude seams (recommendations in D9/D10;
  qa-engineer decides).
- Review-tier final tags (senior-lead; suggestions in D14).
