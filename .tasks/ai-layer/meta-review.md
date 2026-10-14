# Meta-review: ai-layer (senior-lead over code-reviewer's `review.md`)

Reviewer verified the Anthropic/Ollama wire shapes, the server-side validation, the router precedence, the migration byte-identity, the privacy of the dataset and the web rules — I had checked the same at my gate; no disagreement there. Rulings on the 11 findings:

| # | Finding | Ruling | Why / action |
|---|---|---|---|
| 1 | MAJOR replay key uses `fake/fake` in replay mode, so a fixture recorded from a real provider can never replay | **Agree** | Real bug for the whole "replay real answers in CI" promise; only the synthetic fixture happened to work. Fix: replay mode keyed by the `(provider, model)` it was recorded under + a round-trip test with a differently named inner stub. |
| 2 | MAJOR a non-`LLMError` from a provider escapes `categorize` → upload 500 | **Agree** | Contradicts "the import never fails because of AI". Fix: second `except Exception` arm in `run()` → log class only, `aborted="error"`, stop; pin with the probe as a test. |
| 3 | MAJOR `max_tokens` 1200 for a 20-row batch is tight for Russian reasons → silent `truncated` | **Agree** | Unused output budget costs nothing. 150/row, floor 1024. |
| 4 | MAJOR exact salary/tax amounts + the `Карта Поляка` label in the committed dataset | **Partially agree — owner decision** | The dataset is PENDING OWNER REVIEW by design; I do not alter it unilaterally. Flagged in the final report with the two options (bucket `amount_minor` for income/tax rows, or drop the 6 rows). |
| 5 | MINOR `\d{4,}` misses separator-formatted phone/IBAN runs; name pattern Cyrillic-only | **Agree (cheap)** | Add a digits-with-separators rule (≥7 chars of digits/`-`/space); confirm the test name is invented. The committed dataset is already clean on my own audit. |
| 6 | MINOR `truncated` arm untested | **Disagree** | A two-line branch whose failure mode (`max_tokens` stop) is already the `LLMError` path; a test would re-assert the literal. Not added. |
| 7 | MINOR quota `cost=rows` never exercised with rate limiting on | **Agree** | The `cost=` kwarg is the one piece of `limits` we had only verified by signature. One test with `rate_limit_enabled=True`, quota `1/day`. |
| 8 | MINOR eligible rows whose kind has no category read `failed` instead of `skipped` | **Agree** | Status must be computed over rows that could be SENT. Small router change. |
| 9 | NIT file-level `# ruff: noqa` vs the pyproject per-file-ignore precedent | **Agree** | Move it; the "parallel subtask" reason is gone. |
| 10 | NIT dead `?? 0` / `=== true` fallbacks on now-required web fields; stray blank line | **Agree** | Trivial cleanup, frontend. |
| 11 | NIT unrelated files in `git status` | **Agree** | Orchestrator stages by path (listed in the final report). |

Web-QA observations (no defects): (1) "No category" picked explicitly clears the flag — by design (architecture: value OR explicit null = the user looked); (2) the empty state under `exact`+chip describes the intersection — accepted, the chip count beside it is session-wide by design; (3) an overridden llm row loses its source line while the header still counts it — honest history, accepted.

Verdict: findings 1–3, 5, 7–10 fixed in one round (backend + web in parallel), gates re-run by me; 4 goes to the owner; 6 declined; 11 for the orchestrator.
