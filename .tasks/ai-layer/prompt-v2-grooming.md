# categorize-v2 — grooming decisions (senior-lead, 2026-10-20)

Owner brief: `prompt-v2.md`. Tier: **STANDARD+** (prompt/service/evals change, no
migration, no contract change; engineer self-review via `/review-pr`, senior-lead
diff gate, code-only reviewer pass in parallel with the live evals). Architect:
not invoked — no table, no cross-service contract; one new pure module.

## D1. Where the examples come from in production
The RAG index (`transaction_embeddings`, 0020) IS the pool. Re-embedding a user's
history inline is not affordable (5 000 rows × 3.7 ms ≈ 19 s of a 45 s budget),
the stored passage vectors are free. Pool query (DB-aware, lives NEXT to the
pure selector, never inside it — the `tx_search` vs `tx_text` split):
`transaction_embeddings ⋈ transactions` WHERE same `user_id`, `category_id IS NOT
NULL`, `model == embedder.model`, `tx_totals.NOT_TRANSFER_OR_DEBT`, newest first,
`LIMIT categorize_examples_pool_max` (default 5000). Example TEXT shown to the
model = `merchant` else the note's first clause (whitespace collapsed, ≤ 80
chars) — the same shape statement rows have (`display_name`); a row with neither
is skipped. The example's category must be one of the batch's eligible options
(visible, non-archived, same kind) or it is dropped at selection.

## D2. Selection (pure module, numpy + `embeddings.types` + stdlib)
`services/categorize_examples.py`: `ExamplePool(texts, category_ids, matrix)` +
`select(pool, query_matrix, …)`. All UNIQUE operation texts (post-dedupe
representatives) are embedded ONCE per categorize call with `kind="query"` via
`asyncio.to_thread`; scores = `M @ Q.T`; `np.argsort(-scores, kind="stable")`.
Per batch: union of the top-`categorize_examples_per_operation` (default 3) per
operation, then COVERAGE — for every eligible category still absent, its single
best-scoring pool row — then dedupe on `(text.casefold(), category_id)`, then the
hard caps `categorize_examples_max` (default 40 per batch) and
`categorize_examples_max_chars` (default 4000 per batch, the token proxy; stop
adding when exceeded). Order inside the document: by score desc, deterministic
tie-break — the replay key hashes the document.

## D3. The seam into `categorize()`
`categorize.py` stays pure. `CategorizeConfig` gains `prompt_version`
(`"categorize-v1" | "categorize-v2"`); `categorize()` gains an optional
`examples: ExampleSelector | None` — a Protocol `async select(operations,
options) -> Mapping[op_key, …]`/per-batch examples (engineer's exact shape), so
the router injects a pool-backed selector and the eval injects a RECORDED one in
replay (D7). `PROMPT_VERSIONS` tuple + a fingerprint per version pinned by the
existing test; `PROMPT_VERSION` keeps meaning "the default".

## D4. v2 document and prompt
User JSON gains a third array `"examples": [{"text", "category"}]` with
`category` = the c-key (the model answers keys; names are in `categories`).
System text: these are the user's OWN past decisions, the strongest signal for
the same or a similar merchant, may be empty; everything else from v1 stays.

## D5. Honest degrade
A batch that ends up with ZERO examples (no embedder, empty pool, nothing
eligible, selector `None`) is sent as the **v1 request** (v1 system text, v1
document) and logged as `prompt=categorize-v1`. `CategorizeOutcome` carries the
EFFECTIVE `prompt_version` (v2 iff at least one batch carried examples) and
`examples_used`; the router stamps the effective version on the session. So the
stamp always names the prompt that actually went out, and the v1 number applies
to it. `log_call` gains `examples=<n>` — counts only, never text.

## D6. Settings
`categorize_prompt_version` (default = the measured winner, set at the end),
`categorize_examples_per_operation=3`, `categorize_examples_max=40`,
`categorize_examples_max_chars=4000`, `categorize_examples_pool_max=5000`.
Router: `app.state.embedder` may be `None` → selector `None` (D5).

## D7. Evals — leakage-free split, recorded examples, CI without onnx
- `run.py --split test|none` (default `none` = today's full-dataset run, so the
  committed v1 fixtures and the fake replay keep working). `test`: deterministic,
  STRATIFIED per label — within each label, rows in dataset order, every 3rd row
  (index % 3 == 2) → test slice, the rest → history pool. Disjoint by id, pinned
  by a test. The test row is never in the pool by construction.
- History embedding in `live`/`record`: the REAL onnx embedder (`models/`,
  `model_manifest.json`) over `tx_text` passages built from (merchant=text,
  category=label, kind) — mirrors the stored vectors (D1). Query side = the bare
  operation text, `kind="query"`.
- The selected examples per batch are WRITTEN beside the fixture
  (`evals/replay/<provider>-<model>-categorize-v2[-test].examples.json`) in
  `record`; `replay` loads that file into a static selector → identical
  documents → fixture hits. CI never needs the artifact; a changed selection
  algorithm invalidates the file loudly (replay miss), not silently.
- `evals.common.validate_run` accepts any member of `PROMPT_VERSIONS`.
- Report (md + json) gains: `split`, `history_rows`, the **seen** subset
  (`(text.casefold(), kind)` occurs in the pool) vs **unseen** subset — rows,
  accuracy, unsure, flagged for EACH — plus `tokens_in`/`tokens_out` totals and
  `examples_per_call` avg. Stem: `<provider>-<model>-<prompt>[-test]`.
- Runs: v1 and v2 × qwen2.5:7b and llama3.1:8b, all `--split test --mode record`,
  local profile (concurrency 1). Four reports, four fixtures, two examples files.
- CI floor: `EVALS_MIN_ACCURACY` (fake placeholder) → removed as a floor; the
  fake replay test keeps the equality assertion only. New
  `EVALS_MIN_ACCURACY_V2` = a hair below the recorded qwen v2 test-split
  **overall** accuracy, asserted on the replay of
  `ollama-qwen2.5-7b-categorize-v2-test.jsonl`; docstring names the report.
  (The regression also replays v1 llama/qwen? — NO, one real floor is enough;
  the v1 ollama fixtures stay as reproducibility artefacts.)

## D8. Tests (only what can break)
1. split: disjoint, deterministic, every label with ≥3 rows appears on both
   sides; 2. pool loader: two users → only the caller's rows, archived-category
   rows and transfers/debt movements absent (test DB, the `test_tx_search`
   precedent); 3. selector: caps hold, a category absent from the batch's
   options is dropped, coverage adds an absent category; 4. degrade: no selector
   → v1 request + effective version v1; 5. fingerprint pins for both versions;
   6. router: fake provider + fake embedder + a categorized own transaction →
   session stamp `categorize-v2`, `examples=` counted (one test).

## D9. Default
Chosen from the numbers: the version with the higher UNSEEN-subset accuracy on
both models wins; if the models disagree, the one that wins on the app's
shipped `ollama_model` family and does not raise the unsure rate. Recorded in
the final report and in `config.py`'s comment.

## Out of scope
Mobile/web (no UI change: the stamp is already displayed), Anthropic live run
(no key in this session), pgvector, a v2 dataset with notes.
