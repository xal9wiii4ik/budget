# meta-review — categorize-v2 (senior-lead, 2026-10-20)

Reviewer output: `review-v2.md`. My own gate before it: ruff/format/pyright clean,
pytest 870 passed (one run), all seven categorize fixtures replay (fake v1 full,
ollama v1 full ×2, ollama v1 test ×2, ollama v2 test ×2) and the four new reports
reproduce byte-for-byte from replay.

## Lead finding (pre-review)
- L1. `routers/statement_imports.py::_example_selector` → `load_example_pool` runs
  inside `_categorize_rows` but OUTSIDE `categorize()`'s exception shield. A
  failure there would 500 the upload — the "an import never fails because of AI"
  invariant (`docs/backend.md`). Blast radius is small (vector length is
  DB-CHECKed; a SQL failure means the DB is down anyway) but the invariant is
  explicit. Fix: wrap, log exception CLASS only, return `None` (= v1).

## Reviewer findings
- MAJOR 1 (fixture truncated before refusals) — **agree**. `main()` calls
  `start_fixture` before `evaluate()` can refuse; a v2 record run on a machine
  without the artifact wipes a committed fixture to a header and the CI floor
  then fails on a replay miss. Data-loss hazard on committed artefacts; fix now.
- MINOR 2 (foreign-category drop after the version decision) — **agree**: the
  "examples non-empty or key absent" invariant should hold at `_examples_for`,
  not only in `_document`. Few lines.
- MINOR 3 (dedupe key untested) — **agree**; one extra pool row in the existing
  eligibility test, no new test.
- MINOR 4 (sidecar header fields written but not checked) — **agree**; compare
  `prompt_version`/`split`/`history_rows` with the run, same `EvalError`.
- MINOR 5 (no test for the sidecar-version refusal) — **agree**: it is the one
  guard D7 relies on and it can be deleted without any other test noticing.
  One `tmp_path` test.
- NIT 6 (run.py docstring says no real numbers exist) — **agree**, doc drift,
  fix in the same pass per CLAUDE.md.
- NIT 7 (`(text, kind)` vs `text.casefold()`) — **agree**, wording.
- NIT 8 (`skipped` session stamped with the configured v2) — **disagree /
  defer**. The ai-layer architecture states the provider/model/prompt trio is
  set "whenever a provider exists (also for skipped/failed)"; stamping `None`
  on `skipped` would change that documented contract for a cosmetic gain, and
  the effective-version rule already covers every session where something was
  sent. Not taken.

## Decision
One fix round (backend-engineer): L1 + MAJOR 1 + MINOR 2–5 + NIT 6–7. Then
lead re-gate: targeted tests, full pytest once, all seven replays again
(the fixtures must NOT change — none of the fixes touches a request).
