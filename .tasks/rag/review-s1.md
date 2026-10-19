# Review S1 — rag: embeddings seam, artifact, canonical text, index (tier FULL)

Reviewer: code-reviewer, 2026-10-19. Scope: S1 files only (S2's concurrent files ignored).
Probes run: `pytest tests/test_{embeddings,tx_text,tx_index}.py` (12 passed, 3.0 s); targeted
pyright over the S1 files (0 errors); exception-hierarchy probe for `fetch_model.py`;
`git check-ignore` for the `.gitignore` anchoring; apscheduler `max_instances` semantics.
Verdict: **no BLOCKER**. One MAJOR (observability of a muted design guard), five MINOR, three NIT.

## Findings

1. **MAJOR — `refresh()` mutes every IntegrityError into "batch rolled back rows=N", so a CHECK
   violation is a silent, permanent, every-5-minutes failure.**
   `apps/api/src/budget_api/services/tx_index.py:207-213`. The catch is meant for the FK race
   (a row deleted between scan and upsert), but asyncpg's `CheckViolationError` arrives as the same
   `IntegrityError`: a vector that is not 1536 bytes (`vector_dim`), a stamp that is `''`
   (`model_present`) or a non-hex hash would be rolled back, logged by SIZE ONLY, and retried
   forever by the sweep — the batch never shrinks, the index never fills, and the log never says
   why. The plan's "Risky spots" sells the dim CHECK as "refused loudly instead of scoring
   nonsense"; this catch makes it quiet. Secondary: the other ≤31 rows of a rolled-back batch are
   still stale but are neither `embedded` nor `pending`, so `RefreshStats.pending` ("still stale
   afterwards", line 55) under-reports, which S2's `pending_count` will inherit.
   Fix (keeps the never-raises contract): log the class and constraint, not the row —
   `logger.warning("embeddings batch rolled back rows=%d cause=%s", len(batch), type(exc.orig).__name__)`
   (asyncpg's class name carries the kind: `ForeignKeyViolationError` vs `CheckViolationError`;
   neither contains text) — and count the rolled-back batch into `pending`. Optionally branch on
   `getattr(exc.orig, "sqlstate", None) == "23503"` (FK) vs anything else → WARNING with the
   constraint name via `exc.orig.constraint_name`.

2. **MINOR — `verify()` lets an `OSError` escape `load()` → boot traceback, the one outcome D-M4
   forbids.** `embeddings/manifest.py:76-77` reads each file; `is_file()` is True for a file the
   process cannot read (wrong owner on a dev stand, a bind-mount with 0600), so `open()` raises
   `PermissionError`, which is outside `OnnxEmbedder.load()`'s `try` (`onnx.py:98-100`) and not
   `EmbedderLoadError` — `app.py:138` only catches that. Fix: wrap the read in `verify` with
   `except OSError as exc: raise EmbedderLoadError(f"{target}: unreadable ({type(exc).__name__})")`.

3. **MINOR — `fetch_model.py` leaves a traceback on a stream that dies mid-body.**
   `scripts/fetch_model.py:102`: `http.client.IncompleteRead` (and the other
   `http.client.HTTPException`s) are NOT `OSError` subclasses (probed: False), so a CDN drop after
   the headers escapes `main()` as a traceback. Exit is still non-zero and the `.part` file is
   unlinked by the `finally`, so the invariants hold; only the "one stderr line" claim (docstring
   lines 50-52, plan §S1) does not. Fix: `except (OSError, http.client.HTTPException)`.

4. **MINOR — the `max_instances=1` comment is false.** `app.py:274-276` says "the run-now job and
   the interval job share a function and a table; one at a time keeps the row cap meaning what it
   says" — APScheduler's `max_instances` is PER JOB (`schedulers/base.py:474`): the interval job
   cannot overlap with itself, but nothing stops it overlapping the still-running boot backfill.
   What actually prevents that today is `time_budget 120 s < interval 5 min`; raise the budget past
   the interval and two sweeps run concurrently (harmless — idempotent upserts, one embedder lock —
   but the cap is then 2×). Fix: say that; or give both `add_job`s `id="embeddings_sweep",
   replace_existing=True` is NOT right either (it would drop the backfill) — just fix the comment.

5. **MINOR — docs broken by this change are left for S3.** `docs/backend.md:103` ("all three gates
   (fx/recurring/push)"), `:79` (models list), the migrations list (no `0020`) and
   `docs/infra.md:30` (QA-stand recipe without `EMBEDDINGS_SCHEDULER_ENABLED=false`, A3) are
   stale as of this diff. The plan assigns `docs/backend.md`/`infra.md` to S3, so this is a
   deviation sanctioned by the plan — but CLAUDE.md says the pass that breaks a sentence fixes it.
   Acceptable only if S3 is tracked as owing exactly these four lines; the four-gate line and the
   `0020` entry are two minutes now.

6. **MINOR — the FK-race arm (the `IntegrityError` → rollback → `continue` path) has no test.**
   Architecture test seam 2 lists "FK race rolls back one batch"; the plan's test list dropped it
   without a word. It is the one branch of `refresh` that can genuinely break (a session left in
   "needs rollback" state would fail every later batch), and it is cheap: monkeypatch
   `tx_index.stale_rows` to append a `_Stale` with a random `transaction_id`, run `refresh` with
   `batch_size=1`, assert the other rows landed and nothing raised. The time-budget arm is also
   untested but is a two-line `asyncio.timeout` — not worth a test.

7. **NIT — `types.py:28` says `EmbedderLoadError` is "Raised ONLY by load()"**; `onnx.py:161`
   raises it from `embed()` before load. Reword ("by load(), or by embed() on an unloaded embedder").

8. **NIT — `test_the_stamp_fits_the_model_column` pins the exact stamp string**
   (`tests/test_embeddings.py:125`), so every legitimate revision bump edits a test; `len <= 64`
   is the guard that matters. Defensible as a reindex reminder — just know it is one.

9. **NIT — `test_scheduler_wiring` gate-on test really STARTS the sweep** against the test DB
   (run-now job fires on `scheduler.start()`), unlike the fx test whose fetcher is neutered. It is
   harmless (empty DB, fake embedder, job never raises) but the file docstring's "asserts what was
   REGISTERED, never behaviour" is now half true; a sentence there would save the next reader.

## No findings
- Pull-index invariants: stale ⇔ `model`/`text_hash` mismatch (`tx_index.py:147`); DELETE by FK
  cascade (model + migration + test); renames stale by hash (test covers merchant/category/account);
  batch upsert + commit per batch; row cap and time budget both honoured and tested; boot run-now
  job scheduled, never awaited (`app.py:284-289`, wiring test asserts DateTrigger + grace None).
- Load order: load block sits after `sessionmaker` and before the scheduler block, so the sweep
  kwargs capture the post-failure `None` (`app.py:136-141`); only `EmbedderLoadError` is caught — see #2.
- Thread/loop: `to_thread` at both call sites; one `threading.Lock` around tokenise+run, pooling
  outside it; zero-length batch short-circuits in `embed` and never reaches it from `refresh`.
- Byte order: `astype("<f4").tobytes()` spelled; `octet_length = 1536` guards dim/dtype.
- Manifest: all four files verified, first failure wins, missing vs mismatch named; `load()` wraps
  everything after verify into one class-only message; no traceback at boot (bar #2).
- Fetch script: stdlib only; `.part` + `os.replace`; mismatch → unlink + stderr + 2; cached skip
  idempotent; `finally` guarantees no partial file (bar #3's traceback).
- Dockerfile/ignores: `model` stage keyed by manifest+script bytes; manifest copied into runtime;
  `/models` → `/app/models` matches the default; `.dockerignore models/` root-anchored (Docker
  semantics), `.gitignore apps/api/models/` anchored (probed: `src/budget_api/models/` not ignored).
- Migration 0020 vs model: three CHECK bodies byte-identical; names `op.f("ck_…")`/`fk_…`/`pk_…`/
  `ix_…` match `models/base.py` convention and 0017's shape; downgrade symmetric; no backfill.
- Settings: all defaulted; `openapi_export` constructs without a lifespan (no I/O at construction);
  every `create_app` site in tests (3 conftest + advisor/receipts/goal_item_files/health +
  3 wiring + embeddings) sets `embeddings_scheduler_enabled=False` and a non-onnx provider or an
  absent dir — nothing loads the artifact or spawns the sweep.
- `tx_totals` rename: 5 call sites + docstring + backend.md; no `_NOT_TRANSFER_OR_DEBT` left.
- `tx_text`: template, note collapse/cut, version-in-hash pinned; `country_names` 249 + spot checks.
- Tests: each guards a breakable behaviour; no duplicate/vacuous pairs found (the two ONNX tests
  cover different arms: verify-mismatch vs lifespan-None).
- Pyright-strict: the two `Any` aliases (`_ort`, `configure`) are justified by missing/partial stubs
  and scoped to one module; targeted pyright clean.
- Deviations from plan/architecture are explained in code (FLAG-1..5 applied; `off` logs no warning
  on purpose; the 11-package dependency count corrected from uv.lock).
