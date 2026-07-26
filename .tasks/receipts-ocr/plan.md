# Implementation Plan (backend): receipts-ocr (scope 2.1–2.3, 2.5; mobile 2.4 frozen)

Scope-grooming plan. Structured **by subtask** following architecture D14 (S1–S4
backend; S5/S6 are web — referenced only for their contract dependency). Each
subtask is one-engineer-run sized with explicit deps. Nothing is implemented in
this run.

**Order:** S1 → S2 → S3 → (S4 ∥ S3) → [S5 → S6, web]. S4 depends only on S1 and
may run in parallel with S3 (S3's map-read hits an empty `merchant_category_map`
until S4 lands — harmless, resolves to "no map hit").

**Actual project commands** (there is no `make`; the skill's `make test` maps to
these):
- tests: `cd apps/api && uv run pytest`
- contract regen (both artifacts, committed together):
  `cd apps/api && uv run python -m budget_api.openapi_export apps/api/openapi.json`
  then `pnpm --filter @budget/api-client generate`
  (writes `packages/api-client/src/generated/schema.d.ts`). Commit
  `apps/api/openapi.json` + `packages/api-client/src/generated/schema.d.ts`
  together.

---

## Dependency delta (`apps/api/pyproject.toml`) — verified, accurate

Current state (verified): `httpx` is a **dev-group** dependency
(`[dependency-groups].dev`), present in `uv.lock` (0.28.1) only as dev + a
transitive of nothing runtime yet. `anthropic` and `minio` are **absent**.

Delta (in **S1** so later subtasks import freely; `uv.lock` regenerated once):
- `[project].dependencies` += `anthropic>=0.40` (pin exact floor at impl from
  current SDK), `minio>=7.2`, **`httpx>=0.28.1` promoted from dev to main**
  (the receipts pipeline imports it directly for HEAD/GET I/O; `anthropic` also
  pulls it transitively but a direct import must be a direct dep).
- `[dependency-groups].dev`: **remove** the `httpx` line (now main; the test
  suite still imports it — it stays installed as a main dep).

## turbo.json / env — verified

`TEST_DATABASE_URL` is wired at `@budget/api#test.env` (1.2 precedent). The
pytest layer for this scope **mocks both external seams** (`app.state.storage`,
`app.state.receipt_parser`) and constructs `Settings(...)` explicitly with
overrides — it reads **no** `ANTHROPIC_API_KEY` or `S3_*` from the environment
(`anthropic_api_key` defaults to `""`, S3 settings have localhost defaults). So
**no `env` addition to `@budget/api#test` is required** for the pytest layer, and
adding one would be cargo-culting. If QA later writes the opt-in real-MinIO
integration module (D9), that module reads its own `TEST_S3_*`/skip-env and QA
adds it to the test env then — recorded, not done here. `#openapi` inputs already
cover `src/**`; no turbo change for contract regen.

---

# S1 — infra-and-migration   (tier: FULL)

**Depends on:** — · **Contract-touching:** no (no OpenAPI-visible route/schema)

## Files
New:
- `apps/api/alembic/versions/0004_receipts_and_merchant_map.py` — migration 0004.
- `apps/api/src/budget_api/models/receipt.py` — `Receipt` model.
- `apps/api/src/budget_api/models/merchant_category_map.py` — `MerchantCategoryMap`.
- `apps/api/tests/test_receipts_model.py` — DDL/constraint + cascade tests.

Modified:
- `apps/api/src/budget_api/enums.py` — add `ReceiptStatus(StrEnum)`.
- `apps/api/src/budget_api/models/__init__.py` — re-export the two new models.
- `apps/api/src/budget_api/models/transaction.py` — add `receipt_id` (+ `merchant`)
  columns (the model side of the D2 carry-forward; migration adds the DDL).
- `apps/api/pyproject.toml` — dependency delta above; `uv lock`.
- root `docker-compose.yml` — `minio` + `minio-init` services (D9).

## enums.py addition (byte-consistent with the CHECK, TransactionKind precedent)
```python
class ReceiptStatus(StrEnum):
    # Definition order is load-bearing: models/receipt.py rebuilds the status
    # CHECK from this iteration order and must emit SQL byte-identical to
    # migration 0004 (status IN ('pending', 'processing', 'parsed', 'failed')).
    pending = "pending"
    processing = "processing"
    parsed = "parsed"
    failed = "failed"
```

## models/receipt.py (D1)
```python
_STATUS_VALUES = ", ".join(f"'{s.value}'" for s in ReceiptStatus)

class Receipt(Base):
    __tablename__ = "receipts"
    __table_args__ = (
        CheckConstraint(f"status IN ({_STATUS_VALUES})", name="status_valid"),  # -> ck_receipts_status_valid
    )
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True)  # -> ix_receipts_user_id
    storage_path: Mapped[str] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(String(16))
    parsed_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)  # sa.dialects.postgresql.JSONB
    error: Mapped[str | None] = mapped_column(String(64), nullable=True)
    parse_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
```
Naming convention (`base.py`) turns `name="status_valid"` into
`ck_receipts_status_valid`, `index=True` into `ix_receipts_user_id` — matches D1.

## models/merchant_category_map.py (D3)
```python
class MerchantCategoryMap(Base):
    __tablename__ = "merchant_category_map"
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    merchant_norm: Mapped[str] = mapped_column(String(255), primary_key=True)
    category_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("categories.id", ondelete="CASCADE"))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now())
```
Composite PK ⇒ `pk_merchant_category_map` (naming convention `pk_%(table_name)s`),
the exact `ON CONFLICT (user_id, merchant_norm)` upsert target for S4.

## transaction.py additions (D2 — model side)
```python
receipt_id: Mapped[uuid.UUID | None] = mapped_column(
    Uuid, ForeignKey("receipts.id", ondelete="SET NULL"), nullable=True)  # -> fk_transactions_receipts_receipt_id
merchant: Mapped[str | None] = mapped_column(String(255), nullable=True)
```
No index on `receipt_id` (D2 recorded verdict). **PM veto point (open Q1):** if
`merchant` is not stored, drop this column here and from the migration; learning
still works (S4 upsert reads the request field, not the row).

## Migration 0004 (pure DDL, `revision="0004"`, `down_revision="0003"`)
`upgrade()` in this order (mirrors 0002 op-style, all names via `op.f(...)`):
1. `op.create_table("receipts", ...)` — columns per D1; `parsed_json` =
   `postgresql.JSONB(astext_type=sa.Text())` (autogenerate's canonical render);
   `sa.CheckConstraint("status IN ('pending', 'processing', 'parsed', 'failed')",
   name=op.f("ck_receipts_status_valid"))`; FK
   `fk_receipts_users_user_id` CASCADE; `pk_receipts`.
2. `op.create_index(op.f("ix_receipts_user_id"), "receipts", ["user_id"])`.
3. `op.add_column("transactions", sa.Column("receipt_id", sa.Uuid(), nullable=True))`
   + `op.add_column("transactions", sa.Column("merchant", sa.String(255), nullable=True))`.
4. `op.create_foreign_key(op.f("fk_transactions_receipts_receipt_id"),
   "transactions", "receipts", ["receipt_id"], ["id"], ondelete="SET NULL")`.
5. `op.create_table("merchant_category_map", ...)` — composite
   `PrimaryKeyConstraint("user_id", "merchant_norm", name=op.f("pk_merchant_category_map"))`,
   FKs `fk_merchant_category_map_users_user_id` CASCADE and
   `fk_merchant_category_map_categories_category_id` CASCADE, `updated_at`
   `server_default=sa.text("now()")`.

`downgrade()` fully symmetric, reverse order: drop `merchant_category_map`; drop
FK `fk_transactions_receipts_receipt_id`; drop columns `merchant`, `receipt_id`;
drop index `ix_receipts_user_id`; drop table `receipts`.

**Drift guard:** run `uv run alembic upgrade head && uv run alembic check` after
writing the models — the byte-identical CHECK (built from `ReceiptStatus`) and
autogenerate-comparability must hold, exactly as 0002 does.

## docker-compose.yml (D9 — root file, backend-engineer owns)
```yaml
  minio:
    image: minio/minio:RELEASE.2025-04-22T22-12-26Z   # pin at impl
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    ports: ["9010:9000", "9011:9001"]                 # +10 offset convention
    volumes: ["budget_minio_data:/data"]
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 5s
      timeout: 3s
      retries: 5
  minio-init:
    image: minio/mc
    depends_on:
      minio: { condition: service_healthy }
    entrypoint: >
      /bin/sh -c "mc alias set local http://minio:9000 minioadmin minioadmin &&
      mc mb --ignore-existing local/receipts"
volumes: budget_minio_data:   # add alongside budget_pg_data
```
No anonymous policy (private bucket, presigned only). `minio-init` exits 0 after
idempotent bucket create.

## conftest note (verified — no change needed)
`_clean_tables` does row-level `DELETE FROM users`. Both new tables have a
`user_id` FK with `ondelete=CASCADE`, so the per-row cascade clears `receipts`
and `merchant_category_map` on every test (no `TRUNCATE`, no landmine). 0004
seeds **no** rows (pure DDL, no 0005 needed), and neither table has a
`user_id IS NULL` row, so the seed-survival property (the 18 system categories)
is untouched. **Stated verdict: existing cleanup is sufficient; do not modify
conftest.** `_migrated_schema` already runs real `alembic upgrade head`, so 0004
is exercised by every test session and its down-symmetry by session teardown.

## Tests (S1) — `tests/test_receipts_model.py`
Only genuinely-breakable DDL behavior (no column-existence smoke tests):
1. `test_status_check_rejects_unknown` — insert a receipt with `status="bogus"`
   via `db_session` → `IntegrityError` (proves the CHECK is live and its value
   set matches `ReceiptStatus`; the byte-identity is the real risk).
2. `test_user_delete_cascades_receipts_and_map` — create user + receipt + a map
   row, `DELETE FROM users`, assert both tables emptied (guards the isolation
   property the whole suite relies on; new FKs could regress it).
3. `test_merchant_map_composite_pk_conflict` — insert `(user, "acme")` twice with
   different `category_id` via a raw `ON CONFLICT DO UPDATE` → one row, latest
   category (proves the composite PK is the upsert target S4 depends on).

Rationale for exclusions: no test for `receipt_id`/`merchant` column presence, no
FK-name assertions (migration + `alembic check` own those), no `parsed_json` type
test.

---

# S2 — storage-and-receipt-create   (tier: FULL)

**Depends on:** S1 · **Contract-touching:** YES (POST /receipts, GET /receipts/{id})

## Files
New:
- `apps/api/src/budget_api/services/storage.py` — `Storage` class + `PresignedRequest`.
- `apps/api/src/budget_api/schemas/receipt.py` — receipt DTOs (built out here,
  extended in S3).
- `apps/api/src/budget_api/routers/receipts.py` — router; POST + GET (pending path).
- `apps/api/tests/test_receipts.py` — router tests (extended in S3).

Modified:
- `apps/api/src/budget_api/config.py` — S3 + create-rate-limit Settings.
- `apps/api/src/budget_api/rate_limit.py` — per-user key_func + create limit provider.
- `apps/api/src/budget_api/app.py` — construct `Storage` onto `app.state.storage`;
  mount receipts router with `Depends(prime_rate_limit)`.
- `apps/api/openapi.json` + `packages/api-client/src/generated/schema.d.ts` — regen.

## Settings additions (D9/D11 — exact names/defaults)
```python
s3_endpoint_url: str = "http://localhost:9010"   # full URL; Storage splits scheme->secure, netloc->endpoint
s3_access_key: str = "minioadmin"
s3_secret_key: str = "minioadmin"
s3_bucket: str = "receipts"
s3_region: str = "us-east-1"
s3_presign_put_ttl_seconds: int = 600
s3_presign_get_ttl_seconds: int = 300
receipt_create_rate_limit: str = "30/minute"
```
Every field has a default ⇒ existing explicit `Settings(...)` sites
(openapi_export, conftest) keep working with no env.

## services/storage.py (D9 — stateless, Settings-only, no DB/models)
```python
@dataclass(frozen=True)
class PresignedRequest:
    url: str
    method: str
    headers: dict[str, str]
    expires_at: datetime  # UTC, tz-aware

class Storage:
    def __init__(self, settings: Settings) -> None:
        parsed = urlparse(settings.s3_endpoint_url)
        self._client = Minio(parsed.netloc, access_key=..., secret_key=...,
                             secure=(parsed.scheme == "https"), region=settings.s3_region)
        self._bucket = settings.s3_bucket
        self._put_ttl = settings.s3_presign_put_ttl_seconds
        self._get_ttl = settings.s3_presign_get_ttl_seconds

    def object_path(self, user_id: uuid.UUID, receipt_id: uuid.UUID) -> str:
        return f"{user_id}/{receipt_id}.jpg"

    def presign_put(self, path: str) -> PresignedRequest:
        url = self._client.presigned_put_object(self._bucket, path, expires=timedelta(seconds=self._put_ttl))
        # See "Senior-lead flag 1": Content-Type is ADVISORY, not signed.
        return PresignedRequest(url, "PUT", {"Content-Type": "image/jpeg"},
                                _utcnow() + timedelta(seconds=self._put_ttl))

    def presign_get(self, path: str) -> str:
        return self._client.presigned_get_object(self._bucket, path, expires=timedelta(seconds=self._get_ttl))

    def presign_head(self, path: str) -> str:
        return self._client.get_presigned_url("HEAD", self._bucket, path, expires=timedelta(seconds=self._get_ttl))
```
minio-py presigning is pure local SigV4 computation (no network) — safe to call
synchronously in async handlers (D9). Actual I/O (HEAD/GET) is async httpx in S3.

## schemas/receipt.py (S2 subset; ParsedReceipt* land in S3)
```python
class PresignedUpload(BaseModel):
    url: str
    method: Literal["PUT"] = "PUT"
    headers: dict[str, str]          # {"Content-Type": "image/jpeg"} (advisory)
    expires_at: datetime

class ReceiptCreated(BaseModel):
    id: uuid.UUID
    status: ReceiptStatus            # always "pending" here
    upload: PresignedUpload

class ReceiptError(BaseModel):       # {"detail": CODE} — mirrors TransactionError
    detail: str
```

## rate_limit.py additions (reuse AM-C machinery, per-user key — D11)
```python
def receipt_create_limit_value() -> str:
    return _request_settings.get().receipt_create_rate_limit

def receipt_rl_key(request: Request) -> str:
    scope = getattr(request.app.state, "rate_limit_scope", "default")
    uid = getattr(request.state, "rl_user_id", None) or get_remote_address(request)
    return f"{scope}:receipt:{uid}"
```
Per-user (not per-IP): localhost IP is constant, the account is the cost driver.
`request.state.rl_user_id` is stashed by a router dependency (below); falls back
to remote address pre-auth (never hit post-auth-dep). `receipt_parse_limit_value`
is added in S3.

## routers/receipts.py (S2 part)
```python
router = APIRouter()  # mounted at prefix="/receipts", tags=["receipts"], with Depends(prime_rate_limit)

async def _rl_stash_user(request: Request, user: User = Depends(current_active_user)) -> User:
    request.state.rl_user_id = str(user.id)   # runs as a dep, before slowapi's wrapper
    return user

_RECEIPT_ERR = {"model": ReceiptError}
_RATE_LIMITED = {status.HTTP_429_TOO_MANY_REQUESTS: _RECEIPT_ERR}

@router.post("", response_model=ReceiptCreated, status_code=201, responses=_RATE_LIMITED)
@limiter.limit(receipt_create_limit_value, key_func=receipt_rl_key, exempt_when=rate_limit_exempt)
async def create_receipt(request: Request, user: User = Depends(_rl_stash_user),
                         session: AsyncSession = Depends(get_session)) -> ReceiptCreated:
    receipt_id = uuid.uuid4()
    storage: Storage = request.app.state.storage
    path = storage.object_path(user.id, receipt_id)
    receipt = Receipt(id=receipt_id, user_id=user.id, storage_path=path, status=ReceiptStatus.pending.value)
    session.add(receipt); await session.commit()
    presigned = storage.presign_put(path)   # pure-local, no I/O
    return ReceiptCreated(id=receipt_id, status=ReceiptStatus.pending,
                          upload=PresignedUpload(url=presigned.url, headers=presigned.headers,
                                                 expires_at=presigned.expires_at))

@router.get("/{receipt_id}", response_model=ReceiptRead, responses={404: _RECEIPT_ERR})
async def get_receipt(receipt_id: uuid.UUID, user: User = Depends(current_active_user),
                      session: AsyncSession = Depends(get_session)) -> ReceiptRead:
    receipt = await _load_own_receipt(session, receipt_id, user.id)   # user-scoped, no-oracle
    if receipt is None:
        raise HTTPException(404, "RECEIPT_NOT_FOUND")
    return _serialize_receipt(receipt)     # S2: parsed=None, suggestion fields None
```
`ReceiptRead` / `_serialize_receipt` are introduced here in their full S3 shape
(GET must compile with the final schema) but only ever carry pending data until
S3's pipeline writes `parsed_json`. Route ordering: `/{receipt_id}` and
`/{receipt_id}/parse` (S3) — literal `parse` segment, no collision (D12).

## app.py wiring
In `create_app`: `app.state.storage = Storage(resolved)` (constructed once,
`app.state` precedent). Mount:
`app.include_router(receipts.router, prefix="/receipts", tags=["receipts"],
dependencies=[Depends(prime_rate_limit)])` — priming travels with the router
(auth precedent) so it's never mounted unprimed.

## Contract regen (S2) — POST /receipts, GET /receipts/{id}, new components
`ReceiptCreated`, `PresignedUpload`, `ReceiptRead`, `ReceiptError`,
`ReceiptStatus`, `SuggestionSource`, `ParsedReceiptRead`, `ReceiptItem` (the read
schemas are defined in S2 so GET compiles; their populated path is S3). Regen +
commit both artifacts. `test_openapi_export.py` drift test will fail until regen.

## Tests (S2) — `tests/test_receipts.py` (extended in S3)
Storage seam faked via `app.state.storage` (assign a stub after `create_app`; the
class surface is the seam, D9). No real MinIO in the pytest layer.
1. `test_create_receipt_returns_pending_and_upload` — POST → 201, `status ==
   "pending"`, `upload.method == "PUT"`, `upload.url` from the fake, receipt row
   persisted with `storage_path == "{user_id}/{id}.jpg"`.
2. `test_get_receipt_pending` — GET own pending → 200, `parsed is None`,
   `suggested_category_id is None`, `suggestion_source is None`.
3. `test_get_receipt_foreign_is_404` — user B GETs user A's receipt → 404
   `RECEIPT_NOT_FOUND` (no-oracle; one auth test for the router lives here).
4. `test_create_receipt_rate_limited` — app with `rate_limit_enabled=True,
   receipt_create_rate_limit="1/minute"`, two POSTs → second 429 `RATE_LIMITED`;
   plus a second user is NOT limited (proves per-user key, the precedent-setting
   bit). This is the one place per-user keying can silently regress to per-IP.

Excluded: no Pydantic-validation tests, no storage-internal tests (faked seam).

---

# S3 — parse-pipeline   (tier: FULL)

**Depends on:** S2 (S4 optional; empty map ⇒ no map hit) · **Contract-touching:** YES

## Files
New:
- `apps/api/src/budget_api/services/receipt_parser.py` — `ReceiptParser`,
  `ParsedReceipt`, `CategoryOption`, `ReceiptParseError`.
- `apps/api/src/budget_api/domain/money.py` — `to_minor_units` (pure; see note).

Modified:
- `apps/api/src/budget_api/config.py` — anthropic + parse Settings.
- `apps/api/src/budget_api/rate_limit.py` — `receipt_parse_limit_value`.
- `apps/api/src/budget_api/schemas/receipt.py` — `ParsedReceiptRead`, `ReceiptItem`,
  `ReceiptRead` (parsed path), `SuggestionSource`; finalize `_serialize_receipt`.
- `apps/api/src/budget_api/routers/receipts.py` — POST `/{id}/parse` + background task.
- `apps/api/src/budget_api/app.py` — `app.state.receipt_parser = ReceiptParser(resolved)`.
- `apps/api/openapi.json` + generated `schema.d.ts` — regen.

## Settings additions (D10/D11)
```python
anthropic_api_key: str = ""                       # empty default keeps existing Settings(...) sites working
anthropic_model: str = "claude-haiku-4-5-<date>"  # pin exact model-id at impl from SDK docs (open Q4: Haiku default)
receipt_parse_timeout_seconds: int = 90
receipt_parse_stale_seconds: int = 300            # > pipeline timeout, so a live parse can't be double-claimed
receipt_max_bytes: int = 10 * 1024 * 1024         # 10 MiB
receipt_parse_rate_limit: str = "10/minute;100/day"
```

## domain/money.py (NEW pure module — see "Disagreements", minor)
```python
def to_minor_units(total: str, currency: str | None) -> int:
    """Decimal string -> integer minor units, exponent-2 default for unknown
    currencies (server mirror of shared toInputString, 0.4 carry-forward)."""
    return int((Decimal(total) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
```
Exponent 2 is deliberate (0.4: unknown-currency robustness). This is the first
server-side decimal→minor conversion (transactions receive `amount_minor`
directly), so a new `domain/` module is warranted under the D13 domain rule.
Consumed by `_serialize_receipt` to derive `total_minor` at read time from the
stored decimal string (keeps `parsed_json` = model payload + resolved suggestion,
no denormalized column — matches D6's "GET is a pure read").

## services/receipt_parser.py (D10 — stateless, Settings-only, no DB/models)
```python
@dataclass(frozen=True)
class CategoryOption:
    id: uuid.UUID; name: str; kind: str

class ReceiptParseError(Exception):
    def __init__(self, code: str) -> None: self.code = code; super().__init__(code)

class ReceiptItem(BaseModel):        # in schemas/receipt.py, imported here
    name: str
    amount: str | None = None

class ParsedReceipt(BaseModel):      # in schemas/receipt.py
    total: str                       # decimal string as printed
    currency: str | None = None      # 3-letter uppercase or null (validator uppercases/validates)
    merchant: str | None = None
    date: date | None = None
    items: list[ReceiptItem] = []
    suggested_category_id: uuid.UUID | None = None

class ReceiptParser:
    def __init__(self, settings: Settings) -> None:
        self._model = settings.anthropic_model
        self._client = AsyncAnthropic(api_key=settings.anthropic_api_key,
                                      timeout=settings.receipt_parse_timeout_seconds, max_retries=1)
    async def parse(self, image_jpeg: bytes, categories: Sequence[CategoryOption]) -> ParsedReceipt:
        ...  # raises ReceiptParseError(code=...)
```
The 503 `AI_NOT_CONFIGURED` gate lives in the **handler** (empty key), never here,
so an unconfigured key fails fast in-request, not as a background failure (D10).

### Tool-use contract (D10 — forced tool-use, `tool_choice={"type": "any"}`, `max_tokens=2048`, single base64 `image` block `media_type=image/jpeg`)
```python
RECORD_RECEIPT = {
  "name": "record_receipt",
  "description": "Record the parsed contents of a receipt image.",
  "input_schema": {
    "type": "object",
    "properties": {
      "total": {"type": "string", "description": "grand total exactly as printed, e.g. '1234.56'"},
      "currency": {"type": ["string", "null"], "description": "3-letter ISO code (uppercase) or null"},
      "merchant": {"type": ["string", "null"]},
      "date": {"type": ["string", "null"], "description": "YYYY-MM-DD or null"},
      "items": {"type": "array", "items": {
          "type": "object",
          "properties": {"name": {"type": "string"}, "amount": {"type": ["string", "null"]}},
          "required": ["name"]}},
      "suggested_category_id": {"type": ["string", "null"],
          "description": "the id of ONE category from the provided list, or null"}
    },
    "required": ["total", "items"]
  }
}
REJECT_IMAGE = {
  "name": "reject_image",
  "description": "Use when the image is not a readable receipt.",
  "input_schema": {"type": "object",
    "properties": {"reason": {"type": "string", "enum": ["not_a_receipt", "unreadable"]}},
    "required": ["reason"]}
}
```
Category list injected into the prompt text as `{id, name, kind}` triples (the 18
frozen system UUIDs arrive through the same visible-category list, 1.2). Parse
result handling → failure taxonomy (D10):
- tool `reject_image` → `ReceiptParseError("NOT_A_RECEIPT")` if reason
  `not_a_receipt`, else `"UNREADABLE_IMAGE"`.
- `record_receipt` input fails `ParsedReceipt` validation → `"INVALID_MODEL_OUTPUT"`
  (no in-service retry — minimal, D10).
- SDK/network/timeout/refusal-without-tool → `"ANTHROPIC_ERROR"` (catch specific
  `anthropic.APIError`, `httpx.HTTPError`, `asyncio.TimeoutError`; log with
  `receipt_id` context, never bare `except`).

## Parse handler (D5 + claim-token mechanism — senior-lead flag 2)
```python
@router.post("/{receipt_id}/parse", response_model=ReceiptRead, status_code=202,
             responses={**_NOT_FOUND, **_UNPROCESSABLE, 409: _RECEIPT_ERR, 503: _RECEIPT_ERR, **_RATE_LIMITED})
@limiter.limit(receipt_parse_limit_value, key_func=receipt_rl_key, exempt_when=rate_limit_exempt)
async def parse_receipt(request: Request, receipt_id: uuid.UUID, background: BackgroundTasks,
                        user: User = Depends(_rl_stash_user), session: AsyncSession = Depends(get_session)) -> ReceiptRead:
    settings = request.app.state.settings
    if not settings.anthropic_api_key:
        raise HTTPException(503, "AI_NOT_CONFIGURED")                 # fail fast, never a bg failure
    receipt = await _load_own_receipt(session, receipt_id, user.id)  # need storage_path; no-oracle
    if receipt is None:
        raise HTTPException(404, "RECEIPT_NOT_FOUND")
    if receipt.status == ReceiptStatus.parsed.value:
        raise HTTPException(409, "RECEIPT_ALREADY_PARSED")           # terminal, skip HEAD/token
    storage: Storage = request.app.state.storage
    # Object existence + size gate BEFORE the claim (D5): async httpx HEAD on a HEAD-presign.
    head = await _head_object(storage.presign_head(receipt.storage_path))
    if head.status_code == 404:
        raise HTTPException(409, "RECEIPT_NOT_UPLOADED")             # stays pending/failed; client uploads + retries
    if int(head.headers.get("content-length", 0)) > settings.receipt_max_bytes:
        raise HTTPException(422, "IMAGE_TOO_LARGE")                  # receipt untouched
    # Atomic claim with RETURNING -> the claim token is the exact parse_started_at we wrote.
    claim = await session.execute(
        update(Receipt).where(
            Receipt.id == receipt_id, Receipt.user_id == user.id,
            or_(Receipt.status.in_(("pending", "failed")),
                and_(Receipt.status == "processing",
                     Receipt.parse_started_at < func.now() - _stale_interval(settings))))
        .values(status="processing", parse_started_at=func.now(), error=None)
        .returning(Receipt.parse_started_at))
    row = claim.first()
    if row is None:                                                 # lost the claim -> classify off a fresh read
        await session.rollback()
        fresh = await _load_own_receipt(session, receipt_id, user.id)
        if fresh is None: raise HTTPException(404, "RECEIPT_NOT_FOUND")
        if fresh.status == ReceiptStatus.parsed.value: raise HTTPException(409, "RECEIPT_ALREADY_PARSED")
        raise HTTPException(409, "RECEIPT_PROCESSING")              # fresh processing
    claim_token: datetime = row[0]
    await session.commit()
    background.add_task(_run_parse, receipt_id=receipt_id, user_id=user.id,
                        storage_path=receipt.storage_path, claim_token=claim_token,
                        sessionmaker=request.app.state.sessionmaker, storage=storage,
                        parser=request.app.state.receipt_parser, settings=settings)
    return _serialize_receipt(...)  # status processing
```
**Claim-token mechanism (spelled out):** the claim UPDATE uses
`.returning(Receipt.parse_started_at)`; `now()` = Postgres `transaction_timestamp`,
stable within the statement, and RETURNING hands back the exact stored value.
That `datetime` is the token passed to the background task, which uses it in the
guarded terminal UPDATE (`WHERE parse_started_at = :claim_token`). A stale-takeover
overwrites `parse_started_at`, so the original worker's guarded UPDATE matches 0
rows and drops its result. This is the ONLY reliable token (a re-read after commit
could observe a takeover's newer value).

## Background task (D11 steps 1–5 — module-level in receipts.py, fully guarded)
```python
async def _run_parse(*, receipt_id: uuid.UUID, user_id: uuid.UUID, storage_path: str,
                     claim_token: datetime, sessionmaker: async_sessionmaker[AsyncSession],
                     storage: Storage, parser: ReceiptParser, settings: Settings) -> None:
    async with sessionmaker() as session:      # own session; request session is closed
        try:
            image = await _download(storage.presign_get(storage_path))          # 1. httpx GET, 30s
        except (httpx.HTTPError, ...) as exc:
            await _finish_failed(session, receipt_id, claim_token, "DOWNLOAD_FAILED"); return
        cats = await _load_visible_options(session, user_id)                     # 2. visible_categories_clause
        try:
            parsed = await parser.parse(image, cats)                             # 3.
        except ReceiptParseError as exc:
            await _finish_failed(session, receipt_id, claim_token, exc.code); return
        cat_id, source = _resolve_suggestion(session_map_lookup, parsed, cats)   # 4. D6 chain
        await _finish_parsed(session, receipt_id, claim_token,
                             {"model": parsed.model_dump(mode="json"),
                              "suggested_category_id": str(cat_id) if cat_id else None,
                              "suggestion_source": source})                       # 5. guarded terminal UPDATE
```
`_finish_parsed`/`_finish_failed` both run the guarded UPDATE
`WHERE id=:id AND status='processing' AND parse_started_at=:claim_token`;
rowcount 0 ⇒ silently drop (a takeover won). Task never raises (guarded) — an
unexpected error is caught, logged with `receipt_id`, and written as
`ANTHROPIC_ERROR`/`DOWNLOAD_FAILED` per origin.

### D6 suggestion resolution (in the task, step 4)
```python
async def _resolve_suggestion(session, user_id, parsed, options):
    visible_ids = {o.id for o in options}
    norm = normalize_merchant(parsed.merchant or "")   # domain/merchant.py (S4); until S4 lands, map query returns nothing
    if norm:
        mapped = await session.scalar(select(MerchantCategoryMap.category_id).where(
            MerchantCategoryMap.user_id == user_id, MerchantCategoryMap.merchant_norm == norm))
        if mapped is not None and mapped in visible_ids:   # archived/foreign skipped (not in visible list)
            return mapped, "merchant_map"
    if parsed.suggested_category_id in visible_ids:        # unknown/archived id -> silently dropped
        return parsed.suggested_category_id, "model"
    return None, None
```
Precedence map>model>null; archived/foreign map target skipped (not in
`visible_ids`); unknown model id dropped. `normalize_merchant` is S4's function —
S3 imports it; if S3 lands first the import exists but the map is empty (both
lookups miss → null), which is the correct behavior, not a bug.

## schemas/receipt.py finalize
```python
class SuggestionSource(StrEnum):
    merchant_map = "merchant_map"
    model = "model"

class ParsedReceiptRead(BaseModel):
    total: str; total_minor: int; currency: str | None; merchant: str | None
    date: date | None; items: list[ReceiptItem]

class ReceiptRead(BaseModel):
    id: uuid.UUID; status: ReceiptStatus
    parsed: ParsedReceiptRead | None
    suggested_category_id: uuid.UUID | None
    suggestion_source: SuggestionSource | None
    error: str | None
    created_at: datetime
```
`_serialize_receipt` re-validates `parsed_json["model"]` through `ParsedReceipt`
(a drifted document is a loud 500, never silently shipped — D12), derives
`total_minor` via `to_minor_units`, and reads the resolved `suggested_category_id`
/ `suggestion_source` from `parsed_json`.

## responses= declarations (AM-5 honest-422 — see "Disagreements" for the parse fix)
```python
_NOT_FOUND = {404: {"model": ReceiptError}}
_UNPROCESSABLE = {422: {"description": "Business rule rejection (string code) or validation error",
    "content": {"application/json": {"schema": {"anyOf": [
        {"$ref": "#/components/schemas/ReceiptError"},
        {"$ref": "#/components/schemas/HTTPValidationError"}]}}}}}
```
Parse route declares `{**_NOT_FOUND, **_UNPROCESSABLE, 409, 503, 429}` — the 422
is the **anyOf union**, not `ReceiptError` alone (the `receipt_id` uuid path param
auto-emits `HTTPValidationError`; declaring `ReceiptError` alone would suppress
that arm — the exact AM-5 lie). GET declares `{404}` only and lets FastAPI keep
the auto 422 `HTTPValidationError` (no business 422 on GET, so no union needed,
matching the DELETE /transactions precedent).

## Contract regen (S3) — POST /receipts/{id}/parse, populated ReceiptRead/ParsedReceiptRead. Commit both artifacts.

## Tests (S3) — extend `tests/test_receipts.py`
Both seams mocked at `app.state` (fake `receipt_parser` = stub with a settable
`parse` result/exception; fake `storage` returns canned presign URLs; the HEAD/GET
httpx calls `@patch`ed at `budget_api.routers.receipts.httpx...` per convention).
Background tasks run within the ASGI request under `ASGITransport`, so a GET right
after the parse POST observes the terminal state — deterministic.
1. `test_parse_happy_sets_parsed_and_suggestion` — fake parser returns a
   `ParsedReceipt`; POST parse → 202 processing; GET → `status parsed`, `parsed`
   populated, `total_minor` derived, `suggestion_source` set.
2. `test_parse_ai_not_configured` — `anthropic_api_key=""` → 503 `AI_NOT_CONFIGURED`,
   receipt stays pending (no bg failure).
3. `test_parse_not_uploaded` — HEAD 404 → 409 `RECEIPT_NOT_UPLOADED`, status unchanged.
4. `test_parse_image_too_large` — HEAD content-length > cap → 422 `IMAGE_TOO_LARGE`,
   status unchanged.
5. `test_parse_already_parsed_409` — receipt in `parsed` → 409 `RECEIPT_ALREADY_PARSED`.
6. `test_parse_claim_race_one_winner` — fake parser blocks on an `asyncio.Event`;
   fire two parses concurrently → exactly one 202, the other 409
   `RECEIPT_PROCESSING`; release → one terminal write. (Claim-race semantics.)
7. `test_stale_takeover_loser_update_drops` — seed a `processing` receipt with an
   old `parse_started_at` (via `db_session`); call `_finish_parsed` with the STALE
   token after a takeover bumped `parse_started_at` → rowcount 0, row keeps the
   winner's state. (Guarded terminal UPDATE.)
8. `test_parse_failure_taxonomy` — parametrized: parser raises
   `NOT_A_RECEIPT`/`UNREADABLE_IMAGE`/`INVALID_MODEL_OUTPUT`/`ANTHROPIC_ERROR`, and
   download raises → `DOWNLOAD_FAILED`; each lands as `status failed` + that
   `error` code; DB consistency (no partial parsed_json).
9. `test_suggestion_precedence` — parametrized on a seeded map + parser output:
   (a) map entry beats model id; (b) map target archived → skipped, model wins;
   (c) model id unknown → dropped, `suggestion_source is None`.
10. `test_parse_rate_limited` — tight `receipt_parse_rate_limit` → second parse 429.

Excluded: parser-internal prompt-shape tests (that's QA's optional real-call
smoke, D10); no re-test of no-oracle GET 404 (covered in S2).

---

# S4 — merchant-learning-and-confirm-fields   (tier: senior-lead's call — recommend STANDARD)

**Depends on:** S1 (may run ∥ S3) · **Contract-touching:** YES (transactions schemas)

## Files
New:
- `apps/api/src/budget_api/domain/merchant.py` — `normalize_merchant`.
- `apps/api/tests/test_merchant_learning.py` — learning + normalization tests.

Modified:
- `apps/api/src/budget_api/schemas/transaction.py` — `merchant`/`receipt_id` fields.
- `apps/api/src/budget_api/routers/transactions.py` — receipt-ref validation,
  merchant on serialize/write, upsert learning.
- `apps/api/openapi.json` + generated `schema.d.ts` — regen.

## domain/merchant.py (D4 — pure, stdlib only)
```python
def normalize_merchant(raw: str) -> str:
    s = unicodedata.normalize("NFC", raw).casefold().strip()
    return " ".join(s.split())   # collapse internal whitespace; "" => "no merchant"
```
Single call site for both the learning write (S4) and suggestion read (S3).

## schemas/transaction.py additions (D8 — additive, backward-compatible)
```python
# TransactionCreate: + receipt_id: uuid.UUID | None = None
#                    + merchant: str | None = None   (validator: trim, cap 255, "" -> None; mirrors _clean_note)
# TransactionUpdate: + merchant: str | None = None   (NOT receipt_id; re-linking is not a flow)
# TransactionRead:   + receipt_id: uuid.UUID | None
#                    + merchant: str | None
```
`_clean_merchant(v)` helper mirrors `_clean_note` (trim; `""`→None; len≤255 else
ValueError) shared across create/update.

## routers/transactions.py changes
- `_serialize` adds `receipt_id=tx.receipt_id, merchant=tx.merchant`.
- `create_transaction`:
  - if `payload.receipt_id is not None`: validate own receipt (user-scoped load);
    foreign/missing → **422 `RECEIPT_NOT_FOUND`** (body-ref 422, mirrors
    `CATEGORY_NOT_FOUND`; the addressed resource is fine, the body ref is the 422).
    No status requirement (D8: linking pending/failed is harmless).
  - set `receipt_id` + `merchant` on the `Transaction`.
  - after `session.add(tx)`, **before commit**, if `payload.merchant` (non-empty
    after clean) AND `payload.category_id is not None`: upsert
    `merchant_category_map` in the same session (atomic with the insert):
    ```python
    norm = normalize_merchant(payload.merchant)
    if norm:
        await session.execute(pg_insert(MerchantCategoryMap)
            .values(user_id=user.id, merchant_norm=norm, category_id=payload.category_id)
            .on_conflict_do_update(index_elements=["user_id", "merchant_norm"],
                set_={"category_id": payload.category_id, "updated_at": func.now()}))
    ```
    Always upsert (even when confirmed == suggested) — "manual override wins" for
    free (D7). Fires for manual entries carrying a merchant too (feature, D7).
- `update_transaction`: apply `merchant` when in `model_fields_set` (explicit null
  clears — nullable column). **PATCH does NOT learn** (D7 / open Q3 default NO).

## Cross-file 422 note
The transactions `_UNPROCESSABLE` union already exists and already carries the
`ReceiptError`-shaped `{detail}` arm via `TransactionError` — adding
`RECEIPT_NOT_FOUND` needs no schema change (D-contract: "existing AM-5 anyOf union
already covers the shape"). Only the enum-of-codes docs change; no new component.

## Contract regen (S4) — TransactionCreate/Update/Read deltas. Commit both artifacts.

## Tests (S4) — `tests/test_merchant_learning.py` + additions to `test_transactions.py`
1. `test_confirm_learns_merchant_category` — POST /transactions with `merchant` +
   `category_id` → map row `(user, normalize(merchant)) -> category_id` created.
2. `test_learning_override_wins` — two POSTs, same merchant, different category →
   map holds the latest (override-wins; `updated_at` refreshed).
3. `test_no_learning_without_category` — merchant present, `category_id` null → no
   map row (guard condition).
4. `test_receipt_id_cross_user_is_422` — user B POSTs with user A's `receipt_id`
   → 422 `RECEIPT_NOT_FOUND` (ownership validation; the key security assertion).
5. `test_transaction_read_carries_merchant_and_receipt_id` — response echoes both
   (only because they are new fields whose omission would silently break S6 prefill).
6. `test_patch_does_not_learn` — PATCH category on an existing tx with merchant →
   map unchanged (D7 default NO — a genuinely contested branch, worth pinning).
7. `TestNormalizeMerchant` (unit, pure) — casefold, NFC, internal-whitespace
   collapse, empty-after-strip → `""`. (Pure branchy logic used by two code paths
   — the one internal-function exception the conventions allow, justified.)

Excluded: no re-test of category-visibility 422 (covered in test_transactions);
no minor-units test here (that path is S3's `to_minor_units`, tested via the
parsed GET).

---

# S5 / S6 — web (plan-web.md; referenced only for contract dependency)

Backend obligation to these: the S2/S3/S4 contract regens must be committed so
`schema.d.ts` carries `ReceiptCreated`, `ReceiptRead`, `ParsedReceiptRead`,
`ReceiptItem`, `ReceiptError`, `ReceiptStatus`, `SuggestionSource`, and the
`TransactionCreate/Update/Read` `merchant`/`receipt_id` deltas before S5/S6 start.
S5 depends on S3 (parse+poll), S6 on S4+S5 (prefill+confirm). No backend code in
S5/S6.

---

## Senior-lead flag resolutions

**Flag 1 — Presign Content-Type enforcement (D9).** Verified against minio-py's
API: `presigned_put_object(bucket, object, expires)` takes **no** headers and
signs **`SignedHeaders=host` only** — it cannot put `Content-Type` into the SigV4
`X-Amz-SignedHeaders`. So Content-Type is **requested-not-enforced**: the
`POST /receipts` response returns `upload.headers = {"Content-Type":
"image/jpeg"}` as an **advisory** the client SHOULD send, but MinIO will not
reject a PUT that omits or changes it. The **real gate is the parse-time HEAD
check**: `Content-Length` vs `receipt_max_bytes` → 422 `IMAGE_TOO_LARGE`. The
pipeline always base64-sends with `media_type=image/jpeg` regardless of stored
content-type, and the S5 canvas downscale re-encodes to JPEG client-side, so
**HEAD does NOT hard-gate on Content-Type** (that would break screenshot uploads
that don't set the header, for zero benefit). This corrects D9's word "enforced"
(see Disagreements).

**Flag 2 — D5 claim token.** The parse handler runs the claim UPDATE with
`.returning(Receipt.parse_started_at)` and reads the returned value as
`claim_token`. `now()` = Postgres `transaction_timestamp`, fixed within the
statement, and RETURNING hands back the exact persisted `datetime`. That token is
passed into `_run_parse`, whose terminal UPDATE is guarded by
`WHERE status='processing' AND parse_started_at = :claim_token`. A stale-takeover
rewrites `parse_started_at`, so the loser's guarded UPDATE matches 0 rows and
drops its result. A post-commit re-read is NOT used (it could observe a takeover's
newer value) — RETURNING is the only correct source.

**Flag 3 — httpx status.** Verified: `httpx` is currently a **dev-group**
dependency only (`pyproject.toml`), present in `uv.lock` (0.28.1). `anthropic` and
`minio` are absent. Accurate delta: add `anthropic` + `minio` to `[project]
.dependencies`, **promote `httpx` from dev to main** (direct import for HEAD/GET),
remove the dev-group `httpx` line. Done in S1 so downstream subtasks import freely.

## Disagreements with architecture

1. **D9 "enforced Content-Type" is technically inaccurate** (concrete error).
   minio-py cannot sign Content-Type into a presigned PUT (host-only SignedHeaders).
   Correction: advisory header + HEAD Content-Length is the gate (Flag 1). No
   change to the design's intent — only the "enforced" claim and the
   presign_put header semantics.
2. **D12 "parse route 422 = ReceiptError alone" is inaccurate** (concrete error).
   The `POST /receipts/{id}/parse` route has a `receipt_id: uuid.UUID` path param,
   so FastAPI auto-emits an `HTTPValidationError` arm at 422; declaring
   `ReceiptError` alone would suppress it — the exact AM-5 lie the codebase's
   transactions `_UNPROCESSABLE` avoids. Correction: parse's 422 is the **anyOf
   union** (`ReceiptError` + `HTTPValidationError`), identical to transactions
   POST/PATCH. GET stays 404-only (no business 422 → auto arm stands, DELETE
   precedent). This is the only D12 deviation.
3. **New `domain/money.py` module** (addition, not a conflict). D6/D10 specify
   `total_minor` derived by the 0.4 exponent-2 rule but name no home; D13 only
   named `domain/merchant.py`. `to_minor_units` is pure and reused, so it belongs
   in `domain/` per D13's own rule — recording the extra module explicitly.

## Open questions (for PM — only what architecture left open that a PM cares about)

None new. The architecture's Open-Q1 (**store `transactions.merchant`?**) is the
one live fork that shapes S1's migration and S4's write: this plan **assumes
store** (architect's recommendation) and both S1 and S4 note the drop-path if
vetoed. Open-Qs 2–7 are already answered by binding recommendations the plan
implements (409 on re-parse; no PATCH learning; Haiku default via config;
foreign-currency deferred to 3.2; no per-receipt retry cap; one-tx-per-receipt).
I am not re-litigating them.
