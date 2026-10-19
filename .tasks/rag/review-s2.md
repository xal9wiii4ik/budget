# Code review — rag S2 (search, total, MCP, cited Q&A, contract) — tier FULL

Reviewer: code-reviewer, 2026-10-19. Scope: the S2 file list from the brief. Gates NOT re-run (engineer's
run is authoritative); targeted probes only: a Python repro of `advisor_qa._verify` + `prompt_fingerprint`,
line-level greps. The `/advisor/qa` PAT→401 revert and `services/tx_index.py` fix are another line's work and
are treated as DONE (the router no longer imports `current_user_jwt_or_pat`; the test already asserts 401).
`evals/` and `docs/` ignored (S3).

## Findings

### 1. MINOR — the top-k row load is the one unscoped query in the path
`apps/api/src/budget_api/services/tx_search.py:170-176`. `select(Transaction).where(Transaction.id.in_(...))`
carries no `Transaction.user_id == user_id`. Today it is safe only transitively: the ids come from the
candidate select whose `filters` begin with `Transaction.user_id == user_id` (`tx_read_query.read_filters`).
`conventions.md` says EVERY query is `user_id`-scoped, and `user_id` is already a parameter of `search()`
(used only by `refresh`). A future caller passing hand-built `filters` would turn this into an unscoped read.
Fix: add `Transaction.user_id == user_id` to that `where`; one line, no behaviour change.

### 2. MINOR — `net = income − expense` is written three times; the docstring claims once
`services/tx_totals.py:127-128` (RowsTotal docstring: "computed on the wire DTO, so there is exactly one
subtraction in the codebase") vs `routers/tx_search.py:274`, `routers/advisor_qa.py:187` and
`services/advisor_qa.py:158` (`QaTotal.from_minor`). The two routers also duplicate the whole
`SearchTotal(currency=…, income_minor=…, …)` construction. Fix: a `SearchTotal.from_rows(total: RowsTotal,
currency: str)` classmethod in `schemas/tx_search.py` used by both routers (the QA prompt's `net` string can
stay — it is a string, not a wire integer — or take `net_minor` from the DTO). Then the docstring is true.

### 3. MINOR — the money test does not contrast the snapshot arm with the lookup arm
`apps/api/tests/test_tx_search.py:183-190` (`test_the_three_buckets_over_the_returned_rows`). The USD row
is created with the USD→RUB rate already in the table, so arm 2 (snapshot `base_amount_minor`) and arm 3
(`lookup_rate` + `convert_minor`) both yield 400 000; a `converted_total_for_rows` that skipped the snapshot
arm entirely passes. The arm ORDER is the one claim the function exists to reproduce (D-R4, plan §S2). Fix:
give the USD row an explicit `base_amount_minor` override that differs from the rate (e.g. 399 000) and assert
THAT number — the override-wins rule (`conventions.md` §snapshot) is then pinned for the search total too.

### 4. MINOR — the 422 `QA_FAILED` arm is untested
`routers/advisor_qa.py:224-227` maps `invalid_output`/`truncated`/`unsupported` → 422 `QA_FAILED`; nothing
exercises it (the fake cannot emit a blank answer). It is a reachable production arm (a real provider that
answers `{"answer": ""}` or runs out of tokens). Fix: a 6-line stub provider in `test_advisor_qa.py`
(the `CountingProvider` pattern) returning `TextBlock('{"answer":"  ","citations":[]}')` → assert 422
`{"detail":"QA_FAILED"}`. Probe evidence the pure half works: `_verify({'answer':'   ',…})` → `LLMError
("invalid_output")`; `_verify({'answer':' x ','citations':['o2','o1','o2','o9',3]},['o1','o2','o3'])` →
`('x', ['o2','o1'], 3)` — unknown, duplicate and non-string all dropped and counted, order kept.

### 5. NIT — pyright suppression where a cast is the house pattern
`services/advisor_qa.py:357` `# pyright: ignore[reportUnknownVariableType]`. `llm/fake.py::_rows` does the
same narrowing with `cast(list[Any], value)` and no suppression. Fix: `items = cast(list[Any], raw_citations)`.

### 6. NIT — `min_score` is applied to the ROUNDED score
`services/tx_search.py:154-158`: scores are rounded to 4 dp before the `>= min_score` cut, so 0.84996 passes
`min_score=0.85`. Consistent with what the client sees (the reported score is what is compared), so arguably
correct — but worth one comment line saying the cut is on the reported value, so nobody "fixes" it later.

### 7. NIT — `test_advisor_qa.py:1` says "the four refusal arms"
The file tests three refusals (AI_UNAVAILABLE, PAT 401, AI_NOT_CONFIGURED-before-EMBEDDINGS). Either count
the gate-order test as the fourth in the docstring, or add finding 4's test and the count becomes true.

## Clean areas (checked, nothing to report)
- No-oracle: every candidate/row query joins `Transaction` with `read_filters` (first predicate `user_id`);
  Q&A `_operations` scopes by `user_id` + `id IN`; a foreign `account_id` matches nothing and the body equals
  the no-match body (test asserts `foreign == missing`). No 404 anywhere on the read.
- Money: `converted_total_for_rows` reproduces the three arms in `_effective_base_minor`'s order; the Python
  `base_amount_minor is not None` guard is equivalent to SQL under the CHECK `(base_amount_minor IS NULL) =
  (base_currency IS NULL)`; `convert_minor` returns `int` (one ROUND_HALF_UP per row); transfers/`debt_id`
  rows skipped; `unconverted_count` counts exactly the rate-miss rows; the `rates` dict caches `Decimal`
  rates keyed `(currency, occurred_at)`, never an amount.
- numpy: `"<f4"` spelled, reshape `(n, embedder.dim)` behind `model == embedder.model`; `argsort(-scores,
  kind="stable")` over `occurred_at DESC, id` = D-R2 tie rule; `min_score` after top-k; zero candidates →
  return before `embed`; candidate select JOINs `Transaction`; `.limit(max_candidates)`; `candidates` honest
  on both early returns.
- Refresh: user-scoped, before the candidate select (A7), logged only when `embedded > 0`; `pending` =
  `len(stale) − len(todo)` from a user-wide scan after the repair, filter-independent (ASK-6); test pins
  36 → 0 / 64 → 100.
- Gates: search `user → require_embedder → session`, limiter wrapper after deps (503 spends no quota);
  Q&A `user → require_llm_provider → require_embedder → session`; both mounts carry
  `Depends(prime_rate_limit)`; decorator order `@router.get → @limiter.limit → @mcp_tool → def`; own rate
  namespaces `search` / `advisor-qa`; `transactions.router` untouched.
- Q&A: one `structured()` with the enum schema (`additionalProperties: false`); `_verify` drops+counts
  unknown/duplicate/non-string, keeps first-appearance order; blank/non-string `answer` → `invalid_output`;
  zero hits → no provider call (`CountingProvider` test); `unavailable`/`request_rejected` → 503
  `AI_UNAVAILABLE`, else 422 `QA_FAILED`; amounts/total as `to_major_string` strings, model told not to do
  arithmetic; `language` from `Profile.language` (`ru` default); `log_call` once per call (ok and error),
  code-only warning, no operation text logged; `qa-v1` fingerprint pinned and verified (`fb6cd9651d782bc4`).
- Fake `qa` arm: deterministic word-overlap over merchant/note/category, `None` fields tolerated by
  `_string`, `QA_CITE_FOREIGN` appends `o999` AFTER the answer text, `LLMFAIL` → `unavailable`; dispatch
  placed before the categorize fallback.
- MCP: description accurate to `tx_text` (merchant, note, category, country label, account) and to
  `NOT_TRANSFER_OR_DEBT`; scores-relative / use-`total` / `pending_count` / exact-text-tool sentences all
  present; `params=` curated for all nine query params with `limit` not `k`; `READ_TOOLS` between `get_debt`
  and `list_transactions`, snapshot 41, remote read 23 / full 41, allowlist +`GET /transactions/search`,
  `NEVER_PAT` +`POST /advisor/qa`.
- Contract: `openapi.json` ↔ `schema.d.ts` consistent (two routes, seven schemas); 422 arms are raw
  `anyOf [SearchError|QaError, HTTPValidationError]`; 429/503 on the envelope; `limit` 1..50 default 20 on
  both; `min_score` 0..1 nullable; `TransactionRead` embedded, not extended.
- Tests: each guards a breakable claim; no duplicates found (the PAT search test and the allowlist pin
  assert different things).
