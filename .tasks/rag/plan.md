# Implementation Plan: rag (backend) — S1 embeddings+index · S2 search+QA+contract · S3 evals+docs
Implements `architecture.md` D-M1…D-E3 + A1–A7 as written. Insertion points, not prose. Disagreements are `FLAG-n` at the end and planned the architecture's way unless the flag says otherwise.

## Approach
`embeddings/` is a second app-free seam beside `llm/` (numpy + onnxruntime + tokenizers + `config` + stdlib), so `evals/retrieval.py` drives it with no FastAPI and no DB. The artifact is never fetched at runtime: `scripts/fetch_model.py` pulls four pinned files at BUILD time and `OnnxEmbedder.load()` re-verifies the SAME `model_manifest.json` at boot. A missing or tampered artifact is ONE warning and `app.state.embedder = None` ("search not available"), never a boot failure — the `provider_from_settings` rule.

Indexing is PULL. `transaction_embeddings` mirrors the money population (`kind IN (expense,income) AND debt_id IS NULL`); a row is current iff it exists with the current `model` and `text_hash`. A PATCH, a category/account rename and a `TEXT_VERSION` bump are hash mismatches; a DELETE vanishes by FK cascade; no writer is touched and no write can be slowed or failed by the model. Three repair paths call ONE `refresh()`: the 5-min sweep, the boot run-now job (scheduled, never awaited — A2), and a ≤64-row search-time refresh whose remainder is reported as `pending_count` rather than hidden.

Retrieval is in-process numpy over ≤`search_max_candidates` rows (0.56 ms at 20 k, evidence.md) and the TOTAL comes from `tx_totals`, so the three money buckets keep one definition. The Q&A is ONE `structured()` call whose citations are verified against what the server retrieved — unknown/duplicate keys are dropped and COUNTED, which is the number the evals score.

| # | subtask | depends on | files (src/test) |
|---|---|---|---|
| S1 | embeddings seam, manifest, fetch script, Dockerfile stage, settings, lifespan, `country_names`, `tx_text`, model+`0020`, `tx_index` | — | 13 / 5 |
| S2 | `tx_search`+router, schemas, `converted_total_for_rows`, MCP, `advisor_qa`+router, fake `qa` arm, `require_embedder`, contract | S1 | 12 / 6 |
| S3 | evals (generator, retrieval, qa, datasets, replay, regression) + docs | S2 | 7 / 1 |

## S1 [FULL] — the embedding seam, the artifact, the canonical text, the index
### `pyproject.toml` — exact lines (engineer runs `uv add`, not now)
In `[project].dependencies`, alphabetically: `numpy`+`onnxruntime` between `"minio>=7.2.20",` and `"openpyxl>=3.1.5",`; `tokenizers` between `"sqlalchemy[asyncio]…",` and `"uvicorn[standard]…",`.
```toml
    # Local multilingual embeddings (rag): ONNX Runtime + the HF tokenizer + numpy —
    # 126 MB and 4 packages, NOT `fastembed`, which pulls 30 (requests, loguru, pillow,
    # tqdm) for the same three calls. No torch. numpy also runs the cosine scan in
    # services/tx_search.py (0.56 ms over 20 000 rows, evidence.md).
    "numpy>=2,<3",
    # Capped below 2.x: the session options we set (intra/inter-op threads, graph
    # optimisation level) and the int8 MatMulInteger kernel ARE the surface here, and a
    # major bump is free to move both (the apscheduler/mcp rule).
    "onnxruntime>=1.31,<2",
…
    # The XLM-R tokenizer of the e5 artifact, from the pinned tokenizer.json of
    # model_manifest.json. Capped below 1.0: encode_batch plus truncation/padding
    # configuration is the whole API we use, and 0.x may rename it.
    "tokenizers>=0.23,<1",
```
`uv add 'numpy>=2,<3' 'onnxruntime>=1.31,<2' 'tokenizers>=0.23,<1'` from `apps/api`.
### New `apps/api/model_manifest.json` — the ONE pin, read by the fetcher AND by `load()`
```json
{"repo": "intfloat/multilingual-e5-small",
 "revision": "614241f622f53c4eeff9890bdc4f31cfecc418b3",
 "files": {
  "onnx/model_qint8_avx512_vnni.onnx": {"as": "model.onnx", "sha256": "dd476dd0c2514e9b9be83aeb3853fac0763e0bdf4a71645407587d77c48a2d88"},
  "onnx/tokenizer.json":        {"as": "tokenizer.json",        "sha256": "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39"},
  "onnx/tokenizer_config.json": {"as": "tokenizer_config.json", "sha256": "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b"},
  "onnx/config.json":           {"as": "config.json",           "sha256": "bbb7c1333fc4b3e27fbc9cd5d2070aabcc1d4dfb99917c3633e772f97545a6b6"}}}
```
`Embedder.model` = `f"{repo}@{revision[:7]}/{as}"` = `intfloat/multilingual-e5-small@614241f/model.onnx`, 49 chars, inside `String(64)`; the HF-path spelling would be 67 (`FLAG-1`).
### New `apps/api/scripts/fetch_model.py` (stdlib only: argparse, hashlib, json, os, pathlib, sys, urllib)
`main(argv) -> int` (`--manifest PATH --dest DIR [--timeout 60]`) · `_fetch_one(url, target, expected, timeout) -> "cached"|"downloaded"` · `_sha256(path)` (1 MiB chunks).
- URL `https://huggingface.co/{repo}/resolve/{revision}/{hf_path}` (urllib follows the CDN redirect; no token, no `huggingface_hub`). Idempotent: `dest/<as>` present and hashing right → skip, so a rebuild without a pin change re-downloads nothing.
- Streams into `dest/.<as>.part` hashing as it writes; mismatch → unlink + one stderr line (`<as>: sha256 mismatch (expected …, got …)`) + `return 2`; match → `os.replace` (atomic, same fs). `URLError`/`HTTPError`/`TimeoutError` → one stderr line naming the file, `return 2`; no traceback, no partial file left. Exit 0 only when all four verify.
- Documented run line is `python -I fetch_model.py …` in BOTH stands (build and dev): isolated mode, so a stray `json.py` beside the script can never shadow stdlib.
### `Dockerfile` — the model stage (+`FLAG-4`'s manifest copy)
```dockerfile
# --- Model: the embedding artifact, fetched and CHECKSUMMED at build time ---
FROM python:3.12-slim-bookworm AS model
WORKDIR /build
COPY model_manifest.json scripts/fetch_model.py ./
RUN python -I fetch_model.py --manifest model_manifest.json --dest /models/multilingual-e5-small
```
Runtime stage, after the `alembic` COPY: `COPY --chown=app:app model_manifest.json ./model_manifest.json` and `COPY --from=model --chown=app:app /models /app/models`. The layer is keyed by the manifest bytes. `.dockerignore` gains `models/` (the dev fetch dir must not enter the context); root `.gitignore` gains `apps/api/models/` (A3). Image +≈240 MB; a build that cannot reach HF FAILS, by design (A4).
### New package `src/budget_api/embeddings/`
**`types.py`** (numpy+stdlib): `TextKind = Literal["query","passage"]`; `class EmbedderLoadError(RuntimeError)`; `class Embedder(Protocol): name: str; model: str; dim: int; def load(self) -> None; def embed(self, texts: Sequence[str], *, kind: TextKind) -> NDArray[np.float32]`.
**`manifest.py`**: frozen `ManifestFile(hf_path, local_name, sha256)` / `Manifest(repo, revision, files)`; `load_manifest(path)`; `verify(dir, manifest) -> None` (raises `EmbedderLoadError` naming the first missing/mismatching file); `model_stamp(manifest, local_name)`.
**`onnx.py`**
```python
MAX_LENGTH = 128                     # merchant+note+4 short fields; 512 would only slow the sweep
_PREFIX = {"query": "query: ", "passage": "passage: "}   # a property of e5, never of tx_text
class OnnxEmbedder:                  # name = "onnx"; dim = 384; `model` property = manifest stamp
    def __init__(self, model_dir: Path, manifest_path: Path, *, threads: int) -> None   # NO I/O
    def load(self) -> None           # verify → session → tokenizer → warm-up
    def embed(self, texts: Sequence[str], *, kind: TextKind) -> NDArray[np.float32]
```
`load()`: `load_manifest` → `verify` (sha256 of all four, streamed) → `ort.SessionOptions()` with `intra_op_num_threads = inter_op_num_threads = threads` and `graph_optimization_level = ORT_ENABLE_ALL` → `InferenceSession(dir/"model.onnx", opts, providers=["CPUExecutionProvider"])` → `Tokenizer.from_file(dir/"tokenizer.json")` + `enable_truncation(max_length=MAX_LENGTH)` + `enable_padding(pad_id=config["pad_token_id"], pad_token="<pad>")` → one warm `embed(["warmup"], kind="query")`. Everything after `verify` is wrapped `except Exception as exc: raise EmbedderLoadError(f"{dir}: {type(exc).__name__}") from exc` — the `alfa_pdf.text_lines` precedent (a narrow tuple here is a list of ORT/tokenizers internals that moves with the library); the message carries the class, never a traceback.
`embed()`: empty `texts` → `np.zeros((0,384), np.float32)` without touching the session (ORT refuses a 0-batch). Else, under ONE `threading.Lock`: `encode_batch([_PREFIX[kind] + t …])` → `input_ids`/`attention_mask` as int64 arrays, `token_type_ids` zeros fed **only if the session declares it** (`{i.name for i in session.get_inputs()}`) → `out = session.run(None, feeds)[0]`. Outside the lock, mean pooling over the mask then L2:
```python
m = mask.astype(np.float32)[:, :, None]
pooled = (out * m).sum(axis=1) / np.clip(m.sum(axis=1), 1e-9, None)
return (pooled / np.clip(np.linalg.norm(pooled, axis=1, keepdims=True), 1e-12, None)).astype(np.float32)
```
**`fake.py`** — `FakeEmbedder`: `name = model = "fake"`, `dim = 384`, `load()` no-op, `kind` ignored. `_TOKEN_RE = re.compile(r"[^\W\d_]+", re.UNICODE)` (letter runs; digits never become features); per token `bucket = int.from_bytes(hashlib.sha1(token.encode()).digest()[:4], "big") % 384`, `+1.0`, then the same L2 normalisation. `sha1`, never `hash()`: `PYTHONHASHSEED` is randomised per process and a recorded eval fixture must replay. A letter-less text stays all-zero → cosine 0 with everything, which is honest, not an exception.
**`registry.py`** — `embedder_from_settings(settings) -> Embedder | None`: `onnx` → `OnnxEmbedder(Path(model_dir), Path(manifest_path), threads=…)` (construction only, no I/O — the `app.state` seam rule); `fake` → `FakeEmbedder()`; `off` → `None`; anything else → `None` + one WARNING listing the accepted spellings (the `llm/registry` shape).
### New `domain/country_names.py` + `scripts/gen_country_names.py`
Runtime module = a committed literal `COUNTRY_NAMES: Mapping[str, str]` (MappingProxyType, the 249 officially-assigned ISO-3166-1 alpha-2 codes → English short names) + `country_label(code)` → `"Poland (PL)"`, unknown → `"(XX)"`, `None` → `None`. GENERATED ONCE and committed — the `tests/fixtures/alfa/make_fixtures.py` precedent: the generator is committed, never run by the suite or the image, `uv run --with pycountry --isolated --no-project python -I scripts/gen_country_names.py > src/budget_api/domain/country_names.py` (name = `common_name or name`). No runtime dependency, no network; the web keeps `Intl.DisplayNames`.
### New `services/tx_text.py` (pure)
`TEXT_VERSION = "tx-text-v1"`; `MAX_NOTE_CHARS = 300`; `_SEP = " | "`; frozen `TextFacts(merchant, note, category_name, kind, country, account_name)`; `tx_text(facts) -> str`; `text_hash(text) -> str` = `sha256(f"{TEXT_VERSION}\n{text}").hexdigest()`.
Parts in order, empties dropped, joined by `" | "`: merchant · note (`re.sub(r"\s+"," ",note).strip()`, cut to 300) · category name · kind word (`expense`/`income`, English) · `country_label` · account name. NO amounts (a bare `500` pulls every query with a figure — the total is the server's), NO dates (filters). Pinned examples: `Biedronka | kawa i bułki | Продукты | expense | Poland (PL) | Карта BYN`; merchant-only → `Uber`; unknown country → `… | (XX) | …`. Editing the template without bumping `TEXT_VERSION` fails that test; bumping it re-hashes the world and the sweep re-embeds it — that IS the reindex path, no CLI.
### New `models/transaction_embedding.py` + `alembic/versions/0020_transaction_embeddings.py`
`transaction_embeddings`: `transaction_id` Uuid PK FK `transactions.id` CASCADE · `user_id` Uuid NOT NULL FK `users.id` CASCADE `index=True` · `model` String(64) · `text_hash` String(64) · `vector` `LargeBinary` NOT NULL · `embedded_at` DateTime(tz) NOT NULL `server_default=func.now()`. Three hand-written CHECKs, byte-identical in both files (the 0018/0019 rule; `test_core_model` is the only alarm): `CheckConstraint("octet_length(vector) = 1536", name="vector_dim")`, `CheckConstraint("text_hash ~ '^[0-9a-f]{64}$'", name="text_hash_format")`, `CheckConstraint("model <> ''", name="model_present")`. Migration: revision `"0020"`, down `"0019"`, one `op.create_table` with every constraint named through `op.f("ck_transaction_embeddings_…")`/`pk_`/`fk_` + `op.create_index(op.f("ix_transaction_embeddings_user_id"))` (the 0017 `debts` shape). No backfill — the boot sweep IS the backfill. `downgrade()` = `drop_index` + `drop_table`; `transactions` untouched.
### New `services/tx_index.py`
```python
@dataclass(frozen=True) class RefreshStats: embedded: int; pending: int
@dataclass(frozen=True) class SweepConfig: batch_size; max_rows; time_budget_seconds  # .from_settings()
async def stale_rows(session, model: str, user_id) -> list[_Stale]
async def refresh(session, embedder, user_id, *, batch_size, max_rows) -> RefreshStats
async def users_to_sweep(session, model: str) -> tuple[list[UUID], list[UUID]]   # priority, rest
async def sweep_embeddings(*, sessionmaker, embedder, config) -> None            # the job; NEVER raises
```
Stale scan — ONE query per user (`NOT_TRANSFER_OR_DEBT` imported from `tx_totals`, `FLAG-3`; the account join is inner because `account_id` is NOT NULL):
```sql
SELECT t.id, t.merchant, t.note, c.name, t.kind, t.country, a.name, e.model, e.text_hash
FROM transactions t JOIN accounts a ON a.id = t.account_id
     LEFT JOIN categories c ON c.id = t.category_id
     LEFT JOIN transaction_embeddings e ON e.transaction_id = t.id
WHERE t.user_id = :uid AND t.kind <> 'transfer' AND t.debt_id IS NULL
ORDER BY t.occurred_at DESC, t.id
```
stale ⇔ `e.model IS NULL OR e.model <> :model OR e.text_hash <> text_hash(tx_text(row))` (hashed in Python; 5 k rows ≈ one SELECT + 5 k sha256, tens of ms). Discovery (priority half, `FLAG-2` adds `rest`):
```sql
SELECT DISTINCT t.user_id FROM transactions t
  LEFT JOIN transaction_embeddings e ON e.transaction_id = t.id
 WHERE t.kind <> 'transfer' AND t.debt_id IS NULL
   AND (e.transaction_id IS NULL OR e.model <> :model)
```
Upsert per batch, then COMMIT (a crash loses one batch, never the table):
```python
stmt = pg_insert(TransactionEmbedding).values(rows)
await session.execute(stmt.on_conflict_do_update(
    index_elements=[TransactionEmbedding.transaction_id],
    set_={"user_id": stmt.excluded.user_id, "model": stmt.excluded.model, "embedded_at": func.now(),
          "text_hash": stmt.excluded.text_hash, "vector": stmt.excluded.vector}))
```
`vector` = `vec.astype("<f4").tobytes()`, read back with `np.frombuffer(buf, dtype="<f4")` — byte order SPELLED, not inherited from the host. A row deleted between scan and upsert → `IntegrityError` → `await session.rollback()`, one WARNING with the batch size, the batch retried by the next run. Embedding goes through `asyncio.to_thread(embedder.embed, texts, kind="passage")` in `batch_size` chunks.
Sweep: `embedder is None` → ONE info line, return (the `push_jobs` keyless precedent). Else priority users then `rest`, a session per user, the loop under `asyncio.timeout(time_budget_seconds)` (expiry → break, logged), stopping once `embedded` reaches `max_rows`. ONE line per run: `embeddings sweep users=%d embedded=%d pending=%d ms=%d` — no text, no ids. Never raises out of the job (the `materialize_due` contract).
### Modified
**`config.py`**, new block after the reconcile block (every field defaulted — `openapi_export`/conftest keep constructing; NO model-name knob, the model IS the manifest): `embeddings_provider = "onnx"` (`onnx|fake|off`) · `embeddings_model_dir = "models/multilingual-e5-small"` · `embeddings_manifest_path = "model_manifest.json"` · `embeddings_threads = 1` · `embeddings_batch_size = 32` · `embeddings_scheduler_enabled = True` · `embeddings_sweep_interval_minutes = 5` · `embeddings_sweep_max_rows = 2000` · `embeddings_sweep_time_budget_seconds = 120` · `search_max_candidates = 20_000` · `search_max_refresh = 64` · `search_rate_limit = "30/minute"` · (S2) `advisor_qa_rate_limit = "5/minute;30/day"`.
**`app.py`** — `app.state.embedder = embedder_from_settings(resolved)` beside `app.state.llm`. In the lifespan, right after `app.state.sessionmaker = …` and BEFORE the scheduler block (so the gate below reads the post-load value):
```python
embedder = app.state.embedder
if embedder is not None:
    try:
        await asyncio.to_thread(embedder.load)          # 0.3 s, awaited (D-M4)
    except EmbedderLoadError as exc:
        logger.warning("embeddings disabled: %s", exc)
        app.state.embedder = None
```
Fourth gate `or resolved.embeddings_scheduler_enabled` in the build condition, plus:
```python
if resolved.embeddings_scheduler_enabled:
    sweep_kwargs: dict[str, Any] = {"sessionmaker": app.state.sessionmaker,
        "embedder": app.state.embedder, "config": SweepConfig.from_settings(resolved)}
    scheduler.add_job(sweep_embeddings, IntervalTrigger(minutes=resolved.embeddings_sweep_interval_minutes),
                      kwargs=sweep_kwargs, misfire_grace_time=3600, coalesce=True, max_instances=1)
    # Backfill (D-I3b / A2): SCHEDULED, never awaited — readiness must not wait on it.
    scheduler.add_job(sweep_embeddings, next_run_time=datetime.now(UTC),
                      kwargs=sweep_kwargs, misfire_grace_time=None)
```
**`tests/conftest.py`** — `setdefault("embeddings_provider", "fake")` + `setdefault("embeddings_scheduler_enabled", False)` in all three client factories, beside the three scheduler gates (`FLAG-5`). **`models/__init__.py`** — re-export `TransactionEmbedding` (alembic env reads the metadata).
### Tests — 10 new + 1 edited (each guards something that can break)
1. `FakeEmbedder`: same text → same vector across instances, rows unit-norm, a word-sharing query outranks one that does not. *Otherwise every ranking test and the CI evals are vacuous, and a `hash()` bucket passes once then fails next process.*
2. `tx_text`: the three pinned strings + a note with newlines collapsed and cut at 300. *The template IS the embedded document; an edit without a version bump silently redefines every stored vector.*
3. `text_hash` differs under a monkeypatched `TEXT_VERSION`. *That the version is inside the hash is the whole reindex mechanism.*
4. `country_names`: `len == 249`, `PL`/`BY`/`DE` exact, unknown → `(XX)`. *A re-generated or truncated table changes every passage.*
5. `OnnxEmbedder.load()` over a fixture dir whose `model.onnx` is 3 bytes → `EmbedderLoadError` naming the file, no session (no 135 MB artifact needed); and an app booted `onnx` with a missing dir logs one warning, answers `/health` 200, `app.state.embedder is None`. *A missing artifact must never fail boot.*
6. `refresh`: a PATCHed merchant, a renamed category and a renamed account each turn their row stale and get a new hash+vector, while an untouched row's `embedded_at` does not move. *The entire justification for pull-over-push: no writer was touched.*
7. `DELETE /transactions/{id}` leaves no embedding row. *FK cascade is the only thing removing deletions from search.*
8. Sweep cap: 3 users of stale rows with `max_rows=60` → exactly 60 embedded, remainder `pending`, nothing raised; a second run finishes them. *The bound keeping the job off a 2-vCPU box.*
9. Sweep with `embedder=None` → returns, writes nothing, raises nothing. *`EMBEDDINGS_PROVIDER=off` must leave the scheduler harmless.*
10. `test_core_model::TestTransactionEmbeddingConstraints`: a 1535-byte vector, an UPPERCASE hex hash and `model=''` each refused by constraint name. *Alembic cannot diff a CHECK on a table; this is the only byte-identity alarm.*
11. (edited) `test_scheduler_wiring.py` gains the 4th gate: on → interval job + run-now job; off → no scheduler at all.
### Risky spots
- The load block MUST precede the scheduler build, or the sweep kwargs capture an embedder the failure path has since set to `None`.
- `threads=1` + batch 32: a sweep batch holds the lock ~150 ms and a search queues behind it; the search-time refresh (A7) pays that INSIDE the user's request — 64 rows ≈ 0.3 s worst case.
- ORT input names differ between exports: feed `token_type_ids` only when declared, or a future artifact raises `InvalidArgument` on the first call.
- `octet_length(vector) = 1536` is the one guard against a dim/dtype change reaching the table (a float64 array is 3072 → refused loudly instead of scoring nonsense).
### Estimate (agent-minutes): write 110 / gates 30 / verification 25 (incl. the A4 amd64 build + RSS)

## S2 [FULL] — search, the cited Q&A, MCP, the contract
### New `services/tx_search.py`
Frozen `Hit(transaction: Transaction, score: float)`; `SearchResult(hits, total: RowsTotal, pending_count, candidates, model)`; `async def search(session, embedder, *, user_id, base, query, limit, filters, min_score, max_candidates, max_refresh, batch_size) -> SearchResult`. Steps: (1) `refresh(…, max_rows=max_refresh)` — A7: before the candidate query, this user only, logged only when it embedded > 0; (2) candidates = `select(TransactionEmbedding.transaction_id, TransactionEmbedding.vector).join(Transaction).where(*read_filters(...), TransactionEmbedding.model == embedder.model).order_by(Transaction.occurred_at.desc(), Transaction.id).limit(max_candidates)` — the SAME `read_filters` as the list route, so filter semantics cannot drift, and `?kind=transfer` answers an honest empty list because the index holds no transfer; (3) zero candidates → return early, **no model call**; (4) `q = (await asyncio.to_thread(embedder.embed, [query], kind="query"))[0]`; (5) `M = np.frombuffer(b"".join(vectors), dtype="<f4").reshape(n, 384)`, `scores = M @ q`; (6) `order = np.argsort(-scores, kind="stable")[:limit]` — stable over a list already ordered `occurred_at desc, id`, which IS D-R2's tie rule; (7) `min_score` cut AFTER top-k; (8) load the ≤50 rows, re-order by score in Python; (9) `converted_total_for_rows`. Score = raw cosine at 4 dp; NO relative cut-off in v1 (margins are 0.006–0.03).
### `services/tx_totals.py` — one new function (plus `FLAG-3`'s rename)
`@dataclass(frozen=True) class RowsTotal: income_minor; expense_minor; unconverted_count` and `async def converted_total_for_rows(session, rows: Sequence[Transaction], base: str) -> RowsTotal`. Same three arms in the same order as `_effective_base_minor` + the bucket-3 fold: `currency == base` → `amount_minor`; `base_currency == base` with a non-NULL snapshot → `base_amount_minor`; else `lookup_rate` + `convert_minor`, a miss → `unconverted_count += 1` and the row leaves every sum. A transfer or `debt_id` row is skipped (the module's population rule in Python), so no third counter. It lives here so the bucket ORDER is written once; `net_minor` is computed on the wire DTO.
### New `routers/tx_search.py` — mounted at `/transactions` BEFORE `transactions.router`
```python
@router.get("/search", response_model=TransactionSearchRead, responses={**_UNPROCESSABLE, **_UNAVAILABLE})
@_limiter_any.limit(search_limit_value, key_func=user_rl_key("search"), exempt_when=rate_limit_exempt)
@mcp_tool(name="search_transactions", description=…, params={...})     # innermost, above `async def`
async def search_transactions(
    request: Request,
    q: str = Query(max_length=500),
    limit: int = Query(default=20, ge=1, le=50),          # A6: `limit` on the wire, never `k`
    from_: date | None = Query(default=None, alias="from"), to: date | None = …,
    category_id: uuid.UUID | None = None, kind: TransactionKind | None = None, account_id: … = None,
    country: str | None = Query(default=None, pattern=COUNTRY_PATTERN),
    min_score: float | None = Query(default=None, ge=0, le=1),
    user: User = Depends(_stash_rl_user_any),   # 3-line local stash over current_user_jwt_or_pat
    _gate: None = Depends(require_embedder),    # 503 before slowapi's wrapper → no quota spent
    session: AsyncSession = Depends(get_session),
) -> TransactionSearchRead
```
`q.strip()` empty → 422 `SEARCH_QUERY_BLANK`. The local stash exists because the shared `stash_rl_user` is JWT-only and `rate_limit` importing `pat_auth` would cycle. `rate_limit.py` gains `search_limit_value()` + `search_rl_key = user_rl_key("search")`. The mount carries `dependencies=[Depends(prime_rate_limit)]` (an unprimed limiter check 500s) and sits between the `debts` and `transactions` mounts — which also fixes the MCP walk position. `routers/transactions.py` stays byte-identical, its mount comment included.
### New `services/advisor_qa.py` (pure: `llm`+`domain`+stdlib) and `routers/advisor_qa.py`
`PROMPT_VERSION = "qa-v1"`; `PROMPT_FINGERPRINTS = {"qa-v1": "<16 hex>"}`; `MAX_ANSWER_CHARS = 4000`; frozen `QaOperation(key, date, kind, amount, currency, merchant, note, category, country, account, score)`, `QaTotal(income, expense, net, unconverted_count)` (major-unit strings via `to_major_string`), `QaAnswer(answer, cited_keys, dropped, usage)`; `build_schema(keys)` → `{answer: string, citations: array of enum(o*)}`, `additionalProperties: false`; `async def answer_question(provider, *, question, language, base_currency, total, operations, max_tokens=1024, user_id=None) -> QaAnswer` (raises `LLMError`); `prompt_fingerprint()`. User message = ONE document `{"qa": {question, language, base_currency, total, operations:[…]}}`, keys `o1..oN` in rank order. Verification (D-Q5): `citations` must be a list of strings; unknown/duplicate dropped and counted; first-appearance order kept; `answer` stripped, empty → `LLMError("invalid_output")`, else cut to 4000. One `log_call(prompt_version="qa-v1", batch_size=len(operations), user_id=…)` per call.
Router `POST /advisor/qa`, `# MCP: no — in MCP the client model IS the answerer`, deps in order: `user = Depends(stash_rl_user)` (JWT-only) → `Depends(require_llm_provider)` → `Depends(require_embedder)` → the `advisor_qa_rate_limit` decorator → `get_session`; retrieval through `tx_search.search` (one definition of "what was retrieved"); zero hits → NO model call, `answer: null`, `citations: []`. Errors: `unavailable`/`request_rejected` → 503 `AI_UNAVAILABLE`; `invalid_output`/`truncated`/`unsupported` → 422 `QA_FAILED`. Own module — `advisor.py` is the Anthropic-streaming seam.
### Modified
- **`ai_gate.py`** — `require_embedder(request)`: 503 `EMBEDDINGS_NOT_AVAILABLE` when `getattr(request.app.state, "embedder", None) is None`; a distinct string from `AI_NOT_CONFIGURED` because a missing artifact is not a missing key and the web copy differs.
- **`llm/fake.py`** — `_DOCUMENT_KEYS += ("qa",)` and a 4th `_invent` arm placed BEFORE the categorize fallback: cite every operation whose `merchant`/`note`/`category` shares a casefolded letter-word with the question; `answer = "scripted fake answer: " + ", ".join(keys)` or `"scripted fake answer: no match"`; `QA_CITE_FOREIGN` in the question APPENDS `"o999"` (a key no document carries) so the drop arm is reachable on a QA stand; `FAIL_MARKER` in the question → `LLMError("unavailable")`.
- **`schemas/tx_search.py`** — `SearchTotal{currency, income_minor, expense_minor, net_minor, unconverted_count}`, `TransactionSearchHit{transaction: TransactionRead, score}`, `TransactionSearchRead{items, total, pending_count, candidates, model}`, `SearchError{detail}`. `TransactionRead` is EMBEDDED, never extended — one money projection. **`schemas/advisor_qa.py`** — `AdvisorQaAsk{question (AdvisorAsk's caps + blank rule), limit=20 (1..50), from, to, account_id, kind}`, `AdvisorQaRead{answer: str|null, citations: [TransactionSearchHit], dropped_citations, retrieved_count, total, provider, model, prompt_version}`, `QaError{detail}` (imports from `tx_search`, never the reverse).
- **MCP/PAT deltas** — `READ_TOOLS` gains `"search_transactions"` BETWEEN `"get_debt"` and `"list_transactions"` (the walk follows mount order); `fixtures/mcp_tools_snapshot.json` gains it at the same position (40 → 41); `EXPECTED_PAT_ALLOWLIST` + `("GET","/transactions/search")` (43 → 44); `NEVER_PAT` + `("POST","/advisor/qa")` (32 → 33). Description states: searches by MEANING; scores are RELATIVE, never a quality bar; use `total` instead of adding rows; `pending_count > 0` = some recent rows are not searchable yet; `list_transactions?q=` is the exact-text tool.
- **Contract** — `pnpm openapi` from the repo ROOT; `apps/api/openapi.json` + `packages/api-client/src/generated/schema.d.ts` in ONE commit (the drift test enforces it), `schema.d.ts` never hand-edited. Two routes, SEVEN new schemas (the architecture says four: it counts neither error envelope nor `SearchTotal`), three new codes on the `anyOf`/503 arms: `SEARCH_QUERY_BLANK` (422), `QA_FAILED` (422), `EMBEDDINGS_NOT_AVAILABLE` (503); `AI_UNAVAILABLE` reused. `tests/test_cors.py` needs nothing — GET/POST are already hand-listed.
### Tests — 13 new + 4 edited lists
1. Happy search (fake embedder): the word-sharing pair outranks an unrelated row, scores descend, `model`/`candidates` stamped. *The ranking path end to end.*
2. No-oracle: a FOREIGN `account_id` returns a body byte-identical to a filter matching nothing. *A 404 or a different shape would be an existence oracle on another user's account.*
3. `kind=transfer` → empty items, zero total. *Searchable ⇔ totalable (D-T4): no third "excluded" counter.*
4. `total` over one base-currency row, one snapshot row and one rate-less foreign row → income/expense exact, `unconverted_count == 1`. *The only money math this scope adds.*
5. `pending_count`: 100 fresh rows with `search_max_refresh=64` → 36 pending on the first call, 0 on the second. *The honesty guarantee for "I imported, then searched".*
6. `embeddings_provider="off"` → 503 `EMBEDDINGS_NOT_AVAILABLE`, anonymous → 401 on the SAME server. *Gate order: auth before the 503.*
7. `q="   "` → 422 `SEARCH_QUERY_BLANK`. *Every row contains the empty string; a blank query would "match" everything at score 0.*
8. A read-scope PAT gets 200 from `GET /transactions/search`. *The allowlist is derived — the marker can be lost to decorator order.*
9. `search_rate_limit="1/minute"` + limiting on → second call 429 `RATE_LIMITED`. *Guards the mount's `prime_rate_limit`.*
10. QA cites by word overlap and every citation key resolves to a transaction inside the retrieved set. *The product claim "answers link to real operations".*
11. `QA_CITE_FOREIGN` → `dropped_citations == 1`, `o999` absent from `citations`. *The verifier is all that stands between an invented id and the screen.*
12. Zero hits → `answer is None`, `citations == []`, provider recorded ZERO calls. *No paid call for a question with nothing to answer from.*
13. `LLMFAIL` → 503 `AI_UNAVAILABLE`; `llm=None` with the embedder also off → 503 `AI_NOT_CONFIGURED` (AI gate first); PAT → 401. *The three refusal arms and their order.*
14. `qa-v1` fingerprint pin. *Editing prompt or schema without a bump silently invalidates every replay fixture.*
### Risky spots
- `np.argsort(-scores, kind="stable")`: the default quicksort makes ties non-deterministic and test 1 flaky.
- `read_filters` returns filters over `Transaction`, so the candidate select MUST join it — filtering the embeddings table alone would ignore every filter silently.
- Decorator order on the search route (`@router.get` → `@limiter.limit` → `@mcp_tool` above `async def`), or the marker is lost and the tool disappears fail-closed, silently.
- The 503 must resolve before slowapi's wrapper, or an unconfigured server answers `RATE_LIMITED` on the second click (the ai-layer R1 ruling).
### Estimate: write 120 / gates 30 (incl. `pnpm openapi` + the two consumer filters) / verification 25

## S3 [STANDARD] — evals + docs
**Approach.** Two runners beside the existing three, the same `common.py` machinery and `--provider/--mode` grammar plus `--embedder fake|onnx --model-dir`. `evals/gen_retrieval.py --seed` writes `dataset/retrieval-v1/{corpus,queries}.jsonl` from themed RU/PL/EN merchant lists (car, pharmacy, groceries, gifts, PL/DE/BY) with note/category/country/account and tri-lingual queries carrying gold key sets; `--derive-owner` adds one query per `owner-categorize-v1.jsonl` label with ≥3 rows (no new PII — it reads the already-reviewed anonymised file). `evals/retrieval.py` embeds the corpus through `tx_text` + the embedder directly (no DB, no app) and reports recall@5/10/20, MRR, per-language recall and gold-vs-non-gold cosine percentiles (the data behind D-R3's "no default cut-off"). `evals/qa.py` retrieves in memory with the fake embedder and calls `advisor_qa.answer_question` through `replay/fake-fake-qa-v1.jsonl`, measuring raw groundedness (`dropped / citations_before_drop`), citation recall vs `gold ∩ retrieved`, cost and latency. CI runs the FAKE embedder only (D-E2); REAL numbers come from a local `--embedder onnx` run committed as `reports/retrieval-onnx-<model-slug>-tx-text-v1.{md,json}` with `real: true` + the manifest revision and sha256; the fake report opens with `synthetic_banner`.
**Files.** New: `evals/{gen_retrieval,retrieval,qa}.py`, `dataset/retrieval-v1/{corpus,queries}.jsonl`, `replay/fake-fake-qa-v1.jsonl`, two reports; `evals/README.md` gains both runners. Modified: `tests/test_evals_regression.py`. Docs fixed in-pass: `docs/backend.md` (the two routes + codes, the `embeddings/` seam, `tx_text`/`tx_index`/`tx_search`, `converted_total_for_rows`, `0020`, the 4th scheduler gate, and its STALE PAT counts 38/27 → 44/33), `docs/mcp.md` (43 → 44 allowlist pairs; NEVER 30 → 33, already stale at today's 32), `docs/infra.md` (dev one-off fetch line, `EMBEDDINGS_PROVIDER=fake`, the 4th gate in the test-server line, the A3 stand recipe 8021 onnx+fake-LLM / 8022 off+off on DB `budget_qa_rag`), `docs/conventions.md` (artifacts pinned by manifest+sha256, fetched at build time, never at runtime), `docs/deploy.md` (the A4 RSS number, ceiling ≈ 700 MB, `EMBEDDINGS_PROVIDER=off` as the retreat).
**Risky spots.** Re-cutting a dataset invalidates its replay fixture — re-record in the SAME pass (the `gen_alfa`/`gen_reconcile` rule). The floors (`RETRIEVAL_MIN_RECALL_AT_10`, `QA_MIN_GROUNDEDNESS`) are fake-calibrated placeholders a hair below the fake run and must say so in their docstrings. `--derive-owner` copies only `text`/`kind`/`country`. The local onnx run is the only place the real artifact loads outside Docker.
**Tests — 2**, themes: (a) the retrieval pipeline replays/reproduces the in-process fake run identically and clears its floor (guards text assembly, key and chunk mechanics); (b) the QA eval replays the committed fixture and reproduces groundedness and citation recall (guards prompt, schema, verifier). No third: `replay_miss` loudness is already pinned once for the whole machinery.
**Estimate:** write 70 / gates 20 / verification 25 (incl. the local real-onnx run and its report)

## Gates (from `apps/api` unless noted)
`uv run ruff check . && uv run ruff format --check .` · `uv run pyright` · `uv run pytest` · (S1) `uv add …`, then `uv run alembic upgrade head && uv run alembic check` + the `downgrade base` cycle the suite runs, plus `docker build --platform linux/amd64` and one boot for A4 · (S2) `pnpm openapi` from the root + `pnpm --filter @budget/api-client test` + `@budget/web typecheck`.
Review tier FULL for S1/S2 (migration, money math, contract, a new external artifact) → the code-reviewer stage runs, no `/review-pr` self-review owed there; S3 is STANDARD and DOES owe it.

## FLAGS
**FLAG-1 (architecture arithmetic).** §9 stamps `Embedder.model` as `"<repo>@<rev[:7]>/<file>"` while §8 gives `model` `String(64)`: with the HF path that is 67 chars and every insert fails the column. Planned: the stamp uses the manifest's LOCAL name (`model.onnx`) → 49 chars, column unchanged; it is still unique per (repo, revision, artifact), which is all it is for.
**FLAG-2 (D-I3a is blind to hash-only staleness).** The discovery SQL finds users with MISSING or model-mismatched rows. A user whose rows are all indexed but who renamed a category has no such row, so the sweep would never repair him — only his own next search would, and `tx_index`'s own promise (S1 test 6) would hold nowhere else. Planned: discovery returns `(priority, rest)` — priority = that SQL, rest = every user with a population row — and a run walks priority first, then rest, bounded by the TIME budget (scanning is one SELECT + N sha256; the ROW cap bounds embedding, the expensive half). At this scale (357 rows / 60 users dev, low thousands prod) a full scan is tens of ms. If user count ever starves the tail, the fix is a `last_swept_at` column — recorded, not built.
**FLAG-3 (one definition of the money population).** `tx_totals._NOT_TRANSFER_OR_DEBT` is private and `tx_index` needs exactly it. Planned: make it public `NOT_TRANSFER_OR_DEBT` inside `tx_totals.py` (5 call sites, mechanical) and import it. A copied predicate would be a second opinion on which rows are money — precisely what that module exists to prevent.
**FLAG-4 (D-A2 gap).** The stage copies `/models` into the runtime image but not `model_manifest.json`, which `load()` must read to verify. Planned: one extra `COPY --chown=app:app model_manifest.json ./` in the runtime stage plus the `embeddings_manifest_path` setting (relative to cwd like `embeddings_model_dir`: `/app/…` in the image, `apps/api/…` on the host).
**FLAG-5 (test mechanism, not behaviour).** D-M4 says tests swap `app.state.embedder` before the lifespan. Planned instead: two `setdefault`s in the three EXISTING conftest factories, with `"off"` as the `None` arm — no fourth factory and no new seam. A test needing a custom object can still set `app.state.embedder` before `LifespanManager`, because the lifespan loads whatever it finds.

## Open questions
- `min_score` is declared `0..1` while real e5 scores sit in 0.78–0.87. Planned: keep the honest full range and name the band in the tool description; the evals' percentiles decide a default later.
- `AdvisorQaAsk.question` blank is a pydantic `HTTPValidationError` (the `AdvisorAsk` precedent) while the search route's blank `q` is the business code `SEARCH_QUERY_BLANK`. Two shapes for "empty question" is a web-copy question; planned as the architecture says.

## Risks
- **RAM.** +510 MB RSS inside an API container on a 3.8 GB box shared with Postgres/MinIO/Caddy. A4's measurement is the gate; `EMBEDDINGS_PROVIDER=off` is the one-line retreat and vocabulary pruning (−350 MB, a self-made artifact) is the recorded follow-up.
- **Build-time network.** Every image build now depends on huggingface.co. Deliberate (A4), but a deploy during an HF outage cannot produce an image at all — worth knowing before a hotfix night.
- **The sweep is the only reindex.** A `TEXT_VERSION` bump re-embeds the whole ledger at 5-minute intervals bounded by `embeddings_sweep_max_rows`; on a large account that is hours of "stale but honest" (`pending_count`), with no progress anywhere but the log.
- **Fake-embedder evals measure mechanics, not quality.** Any number reaching the README or the résumé must come from a labelled local `--embedder onnx` run (the conventions.md rule).
