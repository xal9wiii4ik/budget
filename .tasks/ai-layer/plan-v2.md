# Implementation Plan: categorize-v2 (few-shot from the user's own history)

Decisions D1–D9: `prompt-v2-grooming.md` (binding). Layout only — no restating.

## Approach
Three seams, no table, no contract change. The pure pass keeps owning every byte
the model sees; the pool query and the embedder live beside it; the eval injects
a RECORDED selection so CI reproduces a real run with no 118 MB artifact.

## New files
- `services/categorize_examples.py` — pure (numpy + `embeddings.types` + stdlib): `SELECTION_VERSION`, `Example`, `ExamplePool`, `SelectionLimits`, `select(...)` per D2.
- `services/categorize_pool.py` — DB-aware: `load_example_pool()` (the D1 query; `NOT_TRANSFER_OR_DEBT` imported from `tx_totals`), `example_text()`, `PoolExampleSelector`.
- `tests/test_categorize_examples.py`, `tests/test_categorize_pool.py`.

## Files to modify
- `services/categorize.py` — `PROMPT_VERSION_V1/_V2`, `PROMPT_VERSIONS`, `SYSTEM_PROMPT_V2` (shared head/rules, per-version array block, so v1 stays byte-identical), `PROMPT_FINGERPRINTS` both, `prompt_fingerprint(version)`, `resolve_prompt_version()`, `CategorizeConfig.prompt_version`, `ExampleSelector`, `categorize(..., examples=)`, per-batch D5 degrade, `CategorizeOutcome.prompt_version`/`examples_used`, docstring changelog.
- `llm/usage.py` — `log_call(..., examples: int = 0)` → `examples=%d` (counts only).
- `routers/statement_imports.py` — `_example_selector()` from `app.state.embedder` + a non-empty pool, else `None`; `_categorize_rows` returns the EFFECTIVE version; `_store_preview` stamps it.
- `config.py` — the five D6 settings; `evals/common.py` — `validate_run(..., allowed)`, `replay_file(..., suffix)`; `evals/run.py` — split, sidecar, report fields.
- `tests/test_categorize.py`, `tests/test_statement_imports_ai.py`, `tests/test_evals_regression.py`; `evals/README.md`, root `README.md`, `docs/backend.md`, `docs/conventions.md`.

## Seam
```python
class ExampleSelector(Protocol):                       # categorize.py
    async def select(self, operations: Sequence[Operation],
                     options: Sequence[CategoryOption]) -> Sequence[Example]: ...
def select(pool: ExamplePool, queries: NDArray[np.float32], *,   # categorize_examples.py
           category_ids: Sequence[uuid.UUID], limits: SelectionLimits) -> tuple[Example, ...]
async def load_example_pool(session, embedder, user_id, *, limit) -> ExamplePool
class PoolExampleSelector:  __init__(self, pool, embedder, limits)
```
Called ONCE PER BATCH; batches partition the post-dedupe representatives, so each
unique text is still embedded exactly once per `categorize` call (D2).

## v2 document and system text
Third array `"examples": [{"text", "category"}]`, `category` = the batch's c-key.
System text = v1 + one paragraph introducing the array (the user's OWN decisions,
prefer them, may be empty, a category with no example is still eligible). ZERO
examples ⇒ the v1 request verbatim (no `examples` key at all) logged as v1.

## Settings (D6)
`categorize_prompt_version` (provisional `categorize-v2`, final after the
measurement; unknown value ⇒ v1 + warning), `_examples_per_operation=3`,
`_examples_max=40`, `_examples_max_chars=4000`, `_examples_pool_max=5000`.

## Eval CLI and report
`--split none|test` (stratified per label, dataset order, `index % 3 == 2` → test);
`--prompt-version` = membership in `PROMPT_VERSIONS`; v2 without `--split test`
refused; v2 live/record without the onnx artifact refused by name. Stems and
fixtures `<provider>-<model>-<prompt>[-test]`, sidecar `<stem>.examples.json`
(header pins `SELECTION_VERSION` + the three limits; mismatch refuses the replay).
Report gains `split`, `history_rows`, `effective_prompt_version`, `seen`/`unseen`
(rows/correct/accuracy/unsure/flagged each), `tokens_in`/`out`, `examples_per_call`.

## Tests (D8, six behaviours)
1. split disjoint + deterministic + every label ≥3 rows on both sides;
2. pool loader: two users, archived category, uncategorized row, transfer;
3. selector: both caps, ineligible category dropped, coverage adds an absent one;
4. degrade: v2 config + no selector → v1 system text, two-array document, effective v1;
5. fingerprint pins for BOTH versions; 6. router: fake provider + fake embedder +
one categorized own transaction → stamp `categorize-v2`, `examples=1` in the log line.

## Risks
Replay keys hash the document, so the sidecar must reproduce the example ORDER;
the header pin is what makes a selection change loud without the artifact. The
existing `ai_prompt_version == PROMPT_VERSION` assertion becomes v1 (empty pool).
