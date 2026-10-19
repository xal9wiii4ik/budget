# Meta-review — rag (senior-lead, 2026-10-19)

Two code-reviewer passes (`review-s1.md`, `review-s2.md`), both FULL tier. Every finding below was fixed in the tree before the scope gate (862 pytest, JS 12/12) and before the live QA run.

## review-s1.md (1 MAJOR, 5 MINOR, 3 NIT)
- MAJOR-1 `tx_index.refresh` swallowed every `IntegrityError` as the FK race and retried forever without a cause, and dropped the batch from `pending`. **Agree** — that is the one place a CHECK violation (dim/dtype drift) would have gone silent. Fixed: the warning carries `sqlstate` + the asyncpg class name reached through `exc.orig.__cause__` (the engineer's deviation from my literal `type(exc.orig).__name__` is correct — the dialect wrapper is `IntegrityError` for both FK and CHECK, so my wording would have reintroduced the problem); the batch counts into `pending`; `TestFkRace` pins it.
- MINOR-2 `PermissionError` escaping `verify()` → boot traceback. **Agree**, fixed (wrapped into `EmbedderLoadError`).
- MINOR-3 `fetch_model.py` tracebacked on `IncompleteRead`. **Agree**, fixed (`http.client.HTTPException` + `OSError` arm).
- MINOR-4 false `max_instances=1` comment. **Agree**, comment corrected.
- MINOR-5 stale doc lines. **Agree**, closed by S3's docs pass.
- MINOR-6 FK-race arm untested. **Agree** — a real branch, one cheap test; added.
- NITs (types.py claim, stamp pin, wiring test starts the sweep): fixed the false claim; the stamp pin stays (nothing else in the suite builds the real stamp); the wiring-test behaviour is acceptable (the sweep no-ops on an empty DB).

## review-s2.md (0 MAJOR, 4 MINOR, 3 NIT)
- MINOR-1 top-k row load without `user_id`. **Agree** (defence in depth — `read_filters` already scoped it transitively); fixed.
- MINOR-2 `net` subtraction written three times. **Partially agree**: one `SearchTotal.from_rows` for the wire; `QaTotal.from_minor` keeps its own — it is the prompt's string-scaling site, not a second opinion on the number. Docstring corrected to say so.
- MINOR-3 three-bucket test did not contrast the snapshot arm with the lookup arm. **Agree** — the test named a branch it never exercised (the CLAUDE.md rule); fixed with a differing override.
- MINOR-4 422 `QA_FAILED` untested. **Agree**; added.
- NIT-5 `cast` vs ignore: deferred (not one line). NIT-6 comment added. NIT-7 was moot after MINOR-4.

## My own rulings corrected during the scope
- I ruled PAT on `/advisor/qa` → 403 citing `/transactions/export`; that route is PAT-aware-unmarked, the right precedent is `/advisor/ask` (JWT-only → 401). The engineer's PAT-aware stash was reverted; artifacts corrected.
- The QA agent's `deploy.md` paragraph claiming the model costs ≈140 MB resident contradicted the measured 560 MB (macOS compresses idle pages); rewritten with the Linux figure as the planning number.

## Live QA (one scope-end run)
API 14/15 ✅ + 1 ⚠ (`Подарки и цветы` #4 behind an Apteka by 0.007 — model ranking, D-R3 confirmed live); web 15/15 ✅; DEF-1 copy fixed; NIT-2 (top-N sentence on a short result) fixed. Follow-ups, not defects: pl recall@10 65.6% vs ru/en 94–96% (`rag-hybrid` — exact-merchant RRF is the obvious lever), srOnly "answer ready" in the nothing-found arm, `?kind=transfer` unreachable from the UI.
