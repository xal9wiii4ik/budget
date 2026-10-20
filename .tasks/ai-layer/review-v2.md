# review-v2 — categorize-v2 (code-only reviewer, 2026-10-20)

Scope: uncommitted diff + `categorize_examples.py`, `categorize_pool.py`, `evals/run.py`, `evals/common.py`, the four tests. Suite/lint not re-run (lead's gates taken as given).

## BLOCKER
None. Privacy holds: the pool SQL is `Transaction.user_id == user_id` (pinned by `test_categorize_pool`); every `logger.*`/`log_call` in the touched files carries counts, exception class names, paths or env values — no operation/example text; the sidecar holds only the committed anonymized dataset texts (same exposure as the fixture itself). The zero-example request is byte-identical to pre-change v1 (`df7238167e54036f` still pins; `examples` key absent). Both `_store_preview` call sites (incl. the IntegrityError retry) receive the effective version from the precomputed triple.

## MAJOR
1. `apps/api/evals/run.py:1116-1126` — `main()` truncates the fixture (`start_fixture`) BEFORE `evaluate()` can refuse. Every new refusal (v2 without `--split test`, missing onnx artifact, empty history pool) fires after the truncation, so `--prompt-version categorize-v2 --split test --mode record` on a machine without `models/` wipes the committed `ollama-qwen2.5-7b-categorize-v2-test.jsonl` to a header line and exits 2 — and the CI floor test then fails on a replay miss. Fix: move `start_fixture` into `evaluate` (guarded by `mode == "record"`) after `_selector()` has loaded the artifact, or run `validate_run` + split check + `history_embedder()` in `main` before truncating.

## MINOR
2. `services/categorize.py:568-580 (_examples_for) / :726-735 (_document)` — the foreign-category drop happens AFTER the version/log decision: a selector returning only ineligible ids yields `SYSTEM_PROMPT_V2` + `"examples": []` (a third document shape), stamped v2 with `examples=N`. Fix: apply the `keys` filter inside `_examples_for` (it has `batch.options`) and return the filtered tuple; `_document` then keeps its invariant "non-empty or absent".
3. `services/categorize_examples.py:149` — the dedupe key `(text.casefold(), category_id)` is untested and the sidecar pin is manual (`SELECTION_VERSION`), so a regression here silently rewrites every v2 document. Fix: add one row `("BIEDRONKA", FOOD, 0.05)` to `TestEligibility`'s pool and assert it does not appear twice — no new test needed.
4. `evals/run.py:782-806 (load_examples)` — the sidecar's `prompt_version`/`split`/`history_rows` are written but never checked on load; a sidecar whose batch keys still match replays silently with stale examples and mislabelled seen/unseen. Fix: compare the three header fields with the run's, same `EvalError`.
5. The sidecar-mismatch refusal is the only guard D7 relies on and has no test. One `tmp_path` sidecar with `selection_version: "examples-v0"` → `pytest.raises(EvalError)` is cheap and genuinely breakable.

## NIT
6. `evals/run.py:50-52` — docstring still says no real-model number exists and "the committed report is the fake's"; four `ollama-*` reports now exist.
7. `evals/README.md:146`, report text in `to_markdown` — say `(text, kind)`; code and grooming D7 use `text.casefold()`.
8. `routers/statement_imports.py:622/630` — a `skipped` session (nothing sent) is stamped the configured `categorize-v2`; documented in backend.md, but a DB reader grouping by stamp sees v2 sessions with no AI rows. `None` would be more honest; low priority.

## Checked and fine
Selection: index mapping `eligible[row]` consistent across `scores`/`best`/`_coverage`; `(-score, pool position)` is a total order; both caps bound count and chars (tests discriminate). Split: positional per label, disjoint, deterministic. `EVALS_MIN_ACCURACY_V2=0.62` < 40/63=0.635 and one lost row (0.619) fails. README table matches the JSON reports (overall, unseen, flagged, +1.3k tokens). No vacuous tests.

## Verdict
Approve after MAJOR 1 (plus the lead's already-known unguarded `load_example_pool`).
MINOR 2–4 are each a few lines and worth taking in the same pass.
Privacy and the D5 degrade are correct as written.
