# Implementation Plan: ai-layer (backend) — S1 llm+categorize, S2 import integration, S3 evals

Implements `architecture.md` D1–D9 + A1–A3 as written. Thesis style: insertion points, not prose.
Nothing here re-decides architecture; disagreements are listed at the end and planned the architecture's way.

## Approach (3 lines)
`llm/` is app-free (Settings + httpx + anthropic only) so `evals/` and `services/categorize.py` import it with no
FastAPI, no DB. `categorize` is the only module that knows the prompt, the schema and the validation; the router
owns every DB write, the limiter and `profile.country`. Degradation is total: any LLM failure leaves rows untouched
and only moves `ai_status`.

---

## S1 [FULL] — `llm/` + `services/categorize.py` + settings

### New files (`apps/api/src/budget_api/`)
- `llm/types.py` — frozen dataclasses `TextPart/ToolResultPart/Message/ToolSpec/LLMRequest/TextBlock/ToolUseBlock/LLMResponse/Usage` + `LLMProvider` Protocol, exactly the architecture's signatures. `tools`/`tool_choice`/`ToolUseBlock`/`ToolResultPart` declared, unused in v1.
- `llm/errors.py` — `LLMError(code)` with `retryable` derived from a module-level frozenset `{"unavailable"}`.
- `llm/structured.py` — `structured(provider, request, schema) -> tuple[dict, Usage]`; `max_tokens` stop → `truncated`, non-JSON first `TextBlock` → `invalid_output`. No pydantic here.
- `llm/anthropic.py` — `AnthropicProvider(model, api_key, timeout, http_client=None)`; `AsyncAnthropic(..., max_retries=1)` as in `receipt_parser.py:132-144`; `output_config={"format":{"type":"json_schema","schema":...}}`, `system=[{"type":"text","text":..., "cache_control":{"type":"ephemeral"}}]`, no temperature. Catch tuple MIRRORS `receipt_parser.py:171` (`TimeoutError, anthropic.APIError, httpx.HTTPError`); split by `getattr(exc, "status_code", None)`: 429/5xx/529/transport/timeout → `unavailable`, other 4xx → `request_rejected` (WARNING log, never the prompt). `tools` non-empty → `unsupported`.
- `llm/ollama.py` — `POST {base}/api/chat` `{model, messages, format: schema, stream: false, options:{temperature:0}}`; `message.content` → one `TextBlock`, `prompt_eval_count`/`eval_count`, `total_duration/1e6`, cost `Decimal(0)`; `ConnectError`/`TimeoutException`/`status >= 400` → `unavailable`.
- `llm/fake.py` — one `FakeProvider(mode, store_path=None)` with the three modes of the architecture (`fake` substring matcher + `LLMFAIL` → `unavailable`; `replay` JSONL keyed by `sha256` of canonical `{provider,model,system,messages,output_schema,max_tokens}` → miss = `replay_miss`; `record` wraps a real provider and appends). Lives in `src/`, not `tests/`: `LLM_PROVIDER=fake` must work on a QA stand.
- `llm/registry.py` — `build_provider(...)` (explicit args, the CLI's entry) + `provider_from_settings(settings)` (app.py's). A1: model picked by provider (`settings.categorize_model` vs `settings.ollama_model`). Keyless `anthropic` or `off` → `None`.
- `llm/usage.py` — `PRICES_USD_PER_MTOK` + "as of 2026-10-14" note, `estimate_cost` (unknown model → `None`), `log_call` emitting the one key=value `logger.info` line of the architecture.
- `llm/__init__.py` — re-exports (types, `LLMError`, `structured`, `build_provider`, `provider_from_settings`).
- `services/categorize.py` — `PROMPT_VERSION = "categorize-v1"`, `PROMPT_FINGERPRINTS = {"categorize-v1": "<16 hex>"}`, `SYSTEM_PROMPT`, `build_schema(keys)`, `Operation/CategoryOption/CategorizeConfig/CategorizeResult/CategorizeOutcome`, `async def categorize(provider, operations, categories, config, quota) -> CategorizeOutcome`. Pure: imports `llm`, `enums`, stdlib only.

### Modified
- `config.py` — a new block after the advisor block (~line 110): the 10 settings of architecture §Migration-steps-5 plus A1 `ollama_model: str = "llama3.1"`. All defaulted (the explicit `Settings(...)` sites: `openapi_export`, `conftest`).
- `tests/conftest.py` — add `make_llm_client(llm=..., **overrides)` mirroring `make_push_client` (conftest.py:174-209): the provider must be on `app.state.llm` BEFORE the first request. Used by S2.

### Risky spots
- **Nullable enum.** Planned spelling: `category` is a plain string enum = batch keys **+ the sentinel `"none"`** (no `anyOf`, no `["string","null"]`), mapped to unsure in validation. Both brief rules hold (strings only, `additionalProperties:false`); if a live 400 ever says otherwise it is captured in `record` mode and the schema moves with a `PROMPT_VERSION` bump.
- **`asyncio.timeout` + semaphore cancellation**: cancelled batches must be "absent from results", not an exception out of `categorize`.
- Dedupe key `(text.casefold(), kind, currency)` must be computed once and reused for the fan-out of the result, or duplicates silently lose their copy.

The one fragment worth spelling out (scheduling + abort + budget):

```python
async def categorize(provider, operations, categories, config, quota) -> CategorizeOutcome:
    results: dict[str, CategorizeResult] = {}
    calls: list[Usage] = []
    aborted: str | None = None
    stop = asyncio.Event()                      # set by the first aborting failure / quota refusal

    async def run(batch: tuple[Operation, ...], options: tuple[CategoryOption, ...]) -> None:
        nonlocal aborted
        async with sem:
            if stop.is_set():
                return
            if not quota(len(batch)):
                aborted, _ = "quota", stop.set(); return
            try:
                parsed, usage = await structured(provider, _request(batch, options), _schema(batch, options))
            except LLMError as exc:
                if exc.code in ("unavailable", "request_rejected"):
                    aborted, _ = exc.code, stop.set()
                return                           # invalid_output / truncated: this batch only
            finally: ...                         # log_call for both arms
            calls.append(usage)
            results.update(_validate(parsed, batch, options, config.threshold))

    try:
        async with asyncio.timeout(config.time_budget_seconds):
            await asyncio.gather(*(run(b, o) for b, o in batches))
    except TimeoutError:
        aborted = aborted or "time_budget"
    return CategorizeOutcome(results, calls, aborted)
```
(`_validate` fans the representative's result out to its dedupe twins; batches are built per kind, `c*`/`o*` keys in the architecture's sort order.)

### Tests — 18, no DB, no network (`tests/test_llm_providers.py`, `tests/test_categorize.py`)
- `test_categorize.py` **11**: happy path with `FakeProvider("fake")` (seed + `needs_review` below/above threshold); out-of-list key; wrong-kind category; `confidence > 1`/NaN; missing key in the answer; dedupe → `len(calls) == ceil(unique/batch)` and twins carry the same result; `max_rows` cap leaves the tail absent; time budget with a sleeping provider → partial + `aborted_reason`; quota refusal aborts the remaining batches; one unparseable batch leaves others intact; **the `PROMPT_FINGERPRINTS` hash pin** (answer (d)).
- `test_llm_providers.py` **7**: Ollama happy body→`TextBlock`+usage; Ollama `ConnectError` → `unavailable`; Anthropic request wire shape (`output_config`, system cache_control, no temperature) asserted on the captured request; 429 → `unavailable`; 400 → `request_rejected`; replay round-trip (record then replay returns the same blocks); replay miss → `replay_miss`. All through `http_client=AsyncClient(transport=MockTransport(...))`.

### Estimate (agent-minutes): write 70 / gates 15 / verification 15

---

## S2 [FULL] — statement-import integration + contract

### Modified
- `enums.py` — append `llm = "llm"` to `StatementSuggestionSource` (append-only: the CHECK is rendered from definition order); new `StatementAiStatus(not_configured, skipped, ok, partial, failed)` in that order.
- `models/statement_import.py` — `_AI_STATUS_VALUES = _values(...)`; `StatementImport`: `ai_status` String(16) + `CheckConstraint(..., name="ai_status_valid")`, `ai_provider`/`ai_model`/`ai_prompt_version` nullable; `StatementImportRow`: `ai_confidence` Numeric(4,3), `ai_reason` String(300), `needs_review` Boolean `server_default text("false")`. The existing `suggestion_source_valid` CHECK (lines 135-139) re-renders with three values automatically.
- `alembic/versions/0018_statement_ai.py` — revision `"0018"`, down `"0017"`, 0017's docstring style; the four upgrade steps + the symmetric downgrade of architecture §Migration-steps 1-4. Names via `op.f("ck_statement_import_rows_suggestion_source_valid")` / `op.f("ck_statement_imports_ai_status_valid")` (0013:169 / 0012:49-54 precedent).
- `schemas/statement_import.py` — `StatementRowRead` + `ai_confidence: float | None`, `ai_reason: str | None`, `needs_review: bool`; `StatementImportRead` + `ai_status: StatementAiStatus`, `ai_provider/ai_model/ai_prompt_version: str | None`, `ai_rows_suggested: int`, `ai_rows_flagged: int`; new `AiCounts` is NOT a wire model — flat fields (the existing `by_match_status` nesting is per-cross-section, these are two scalars).
- `routers/statement_imports.py`:
  - new `async def _categorize_rows(...) -> tuple[Mapping[int, CategorizeResult], StatementAiStatus, provider|None]` helper above `create_statement_import`; it loads the visible non-archived categories (one query, `category_access.visible_categories_clause` + the receipts `CategoryOption` precedent), reads `profile.country`, builds `Operation`s for rows with `suggestion is None and match_status != exact`, owns the quota closure, calls `categorize`, maps `aborted_reason`/coverage → `ai_status`.
  - upload handler (after `suggestions = await suggest_categories(...)`, line ~768): `ai, ai_status, provider = await _categorize_rows(...)`; both `_store_preview` calls get `ai` + the stamps (answer (c)).
  - `_store_preview` — two new params, stamps `ai_status`/`ai_provider`/`ai_model`/`ai_prompt_version` on `session_row`, forwards `ai` to `_build_rows`.
  - `_build_rows` — new `ai: Mapping[int, CategorizeResult]` arg; per-row seeding exactly as architecture §"Row seeding" (valid → `suggested_category_id`+`category_id`+`suggestion_source='llm'`, `category_user_set` stays false; unsure → confidence only + `needs_review`; absent → untouched).
  - `_counts` / `_counts_of` — answer (b) below; `_serialize` / `_serialize_row` carry the new fields (`float(row.ai_confidence)` at the boundary).
  - `list_statement_import_rows` — A2: `needs_review: bool | None = None` → `filters.append(StatementImportRow.needs_review.is_(needs_review))`, combinable with `match_status`, applied to both the count and the page.
  - `patch_statement_import_row` — inside the existing `if "category_id" in payload.model_fields_set:` block (line ~1006): `row.needs_review = False`. `decision`-only PATCH and bulk-decision untouched.
- `app.py` — `app.state.llm = provider_from_settings(resolved)` beside the other seams (~line 290), with the "may be None = not configured" comment.
- Contract pair: `apps/api/openapi.json` + `packages/api-client/src/generated/schema.d.ts` via `pnpm openapi` from the root, same commit.
- `apps/web/src/features/imports/ImportRow.tsx:50-53` + `i18n/dict.{ru,en}.ts` — ONE label (`llm: 'imports.suggestedByLlm'`): that map is `satisfies Record<NonNullable<StatementRowRead['suggestion_source']>, string>`, so appending `llm` to the enum turns `pnpm turbo typecheck` RED without it. Nothing else in the web — the flag chip, the reason and the `ai_status` copy are the frontend scope's (see Open question).

### Risky spots
- The rebuilt CHECK must stay byte-identical between model and migration — enum append position is the whole guard (test below).
- `_counts_of` grouping change must not alter the two existing cross-sections (same query, two extra aggregate columns).
- Quota: `limiter.limiter.hit(item, f"{scope}:categorize:{user_id}", cost=n)` over `parse_many(settings.categorize_daily_row_quota)` guarded by `settings.rate_limit_enabled` (pat_auth.py:162-186 precedent); a failed batch is not refunded (documented, not fixed).
- `pyright`: `CategorizeResult` mapping keyed by `row_index` (int), not by the service's `o*` key — the translation happens in `_categorize_rows`, one place.

### Tests — 8 (`tests/test_statement_imports_ai.py` new; CHECK test joins `test_core_model.py`)
Router through the `app.state.llm` seam (`make_llm_client`), real Postgres, real everything else: **7** — name-match rows come back `suggestion_source=llm` + seeded `category_id` + `ai_confidence`, session `ai_status=ok`; a low-confidence row is flagged and NOT seeded; `LLMFAIL` leaves rows untouched with `ai_status=partial`/`failed` and the import still 201; `llm=None` (`LLM_PROVIDER=off`) → `not_configured` and byte-identical row shape to today; exact-match + rules-covered rows are never sent (asserted via a counting fake); PATCH with a `category_id` clears `needs_review` while a decision-only PATCH does not; `?needs_review=true` filter + `ai_rows_flagged` counted at read after a PATCH. **1** CHECK byte-identity: `suggestion_source='llm'` inserts, a fourth value raises `ck_statement_import_rows_suggestion_source_valid`; a bad `ai_status` raises `ck_statement_imports_ai_status_valid`.
No new MCP test: `tests/test_mcp_exposure.py` pins the derived allowlist and must stay green unchanged (no markers added here).

### Estimate: write 60 / gates 25 (incl. `pnpm openapi` + consumer suites) / verification 15

---

## S3 [STANDARD] — `apps/api/evals/`

### New files
- `evals/__init__.py`, `evals/README.md` (live/record/replay, "no numbers until a real run", the owner-review step).
- `pyproject.toml` — `pythonpath = ["."]` in `[tool.pytest.ini_options]` (so `tests/test_evals_regression.py` can `import evals…`; `include = ["src", "tests"]` today does not cover the directory) and `"evals"` appended to `[tool.pyright].include`, or the whole package escapes both gates.
- `evals/anonymize.py` — a plain argparse script, run as `uv run python evals/anonymize.py <raw.csv>` from `apps/api` → writes `evals/dataset/owner-categorize-v1.jsonl` + the review table to `.tasks/ai-layer/real-anonymize-review-local.md` (gitignored by `real-*-local.*`). Rules: `text = merchant` when non-empty, else the note's FIRST clause (split on `.` `,` `:` `(` ` — `); strip card/account/phone/4+ digit runs; drop bookkeeping phrases by regex list ("Дата — допущение", "платёж N из M", "N-й за цикл", "РАЗОВАЯ"); a STOPLIST of relation words/person names (девушке, другу, маме, жене, …) → row DROPPED (safer than a word strip: "Перевод девушке" minus the word is "Перевод", a label-free noun) and counted; empty category or empty resulting text → dropped and counted. Company/merchant names kept verbatim. Review table columns: `id | raw merchant | raw note | → text | kind | amount | label | action(kept/dropped+reason) | ambiguity group size`.
- `evals/dataset/owner-categorize-v1.jsonl` — `{id, kind, amount_minor, currency, country, text, label}`; `evals/dataset/categories.json` — `{"version":1,"labels":[{"id": uuid5(NS, name), "name":..., "kind":"expense"|"income"}]}` (stable ids, kinds; answer (e)).
- `evals/run.py` — argparse `--provider anthropic|ollama|fake --model --prompt-version --mode live|record|replay --threshold --limit`; builds the provider via `llm.registry.build_provider` and calls `services.categorize.categorize` with the production `CategorizeConfig` and `quota=lambda n: True`; prints and writes `evals/reports/<provider>-<model>-<prompt>.{md,json}`: accuracy overall + per label, unsure rate, flagged rate, cost (sum `estimate_cost`), p50/p95 latency, **ambiguity ceiling** (see Disagreements), and the run's mode/date.
- `evals/replay/fake-fake-categorize-v1.jsonl` — produced NOW with `--provider fake --mode record`, first line a header `{"produced_by":"fake", "note":"synthetic, not a real model"}`.
- `tests/test_evals_regression.py` — A3, an ordinary pytest test: replay over the committed dataset + fixture, `assert accuracy >= EVALS_MIN_ACCURACY` (a constant in `evals/run.py`), `replay_miss` propagates and fails loudly, no network, no DB.

### Risky spots
- The fake fixture must NOT be a 100% oracle. Planned deterministic behaviour: in `record` runs the fake answers the **gold label** for every operation **except every 5th one of a batch** (index % 5 == 4), which answers the sentinel `"none"` → unsure. Expected accuracy is then exactly `1 - ceil(N/5)/N` computed in the test from the dataset, so a silent change to batching, dedupe, validation or prompt keys moves the number and the test fails. Labeled synthetic in the fixture header and the report.
- Replay keys embed the system prompt + schema: any prompt edit invalidates the fixture → `replay_miss`, which is the intended loud failure (regenerate + bump `PROMPT_VERSION`).
- Dedupe means the dataset's row count ≠ the model's call count; accuracy is computed over DATASET rows after the fan-out, or duplicates would be double-counted.
- No real-model numbers anywhere: `reports/` ships only the fake run; README says so.

### Tests — 5
`test_evals_regression.py` **3**: replay accuracy equals the computed expectation and clears the threshold; a tampered/absent fixture entry raises `replay_miss` (not a silent 0%); `categories.json` ↔ dataset integrity (every label exists, kinds match the row's kind).
`tests/test_evals_anonymize.py` **2**: note→first-clause + digit-run stripping + bookkeeping-phrase removal on synthetic inputs (never the owner's rows); a stoplist/empty-label row is dropped AND counted in the summary.

### Estimate: write 50 / gates 10 / verification 15

---

## Answers asked in the brief
- **(a) `profile.country`** — ONE read in the upload handler, inside `_categorize_rows` and only when a provider exists and eligible rows exist: `await session.scalar(select(Profile.country).where(Profile.user_id == user.id))` (the advisor.py:150-153 precedent — the COLUMN, never the instance). Nullable: `None` when there is no profile or the field is unset, and it is passed through to `Operation.country` as `None`, never `""`.
- **(b) `_counts`** — both counters are READ, not stored. `_counts(rows)` (upload, in memory) returns a third member `AiCounts(rows_suggested=sum(r.suggestion_source == 'llm'), rows_flagged=sum(r.needs_review))`. `_counts_of` keeps its single grouped query and adds two aggregates to the SAME select: `func.count().filter(StatementImportRow.suggestion_source == StatementSuggestionSource.llm.value)` and `func.count().filter(StatementImportRow.needs_review.is_(True))`, summed across groups in the existing loop — no extra round trip. `_serialize` takes the third tuple member.
- **(c) IntegrityError retry** — the LLM pass runs BEFORE the `try:` and produces plain data (`ai` mapping + status + stamps), exactly like `suggestions`; both `_store_preview` calls receive the same objects. The retry therefore spends no tokens, hits no quota a second time and cannot produce a different preview than the first attempt.
- **(d) `PROMPT_VERSION` pin** — `services/categorize.py` carries `PROMPT_FINGERPRINTS: dict[str, str]` next to `PROMPT_VERSION`; the value is `sha256(SYSTEM_PROMPT + canonical JSON of build_schema(<2 fixed keys>))[:16]`. `test_categorize.py` asserts `PROMPT_FINGERPRINTS[PROMPT_VERSION] == <recomputed>`, so editing the system text or the schema without bumping the version (and adding its entry) fails the suite; the evals replay store adds the second, independent alarm.
- **(e) income labels** — `categories.json` carries `kind` per label; `Зарплата` is `income`. Batching is per kind (architecture), so the income rows form their own batch whose enum contains only income labels; with the raw file's 7 income rows (3 `Зарплата`, 4 label-less → dropped) that is one batch of 3. A row whose kind has NO eligible category is never sent (left untouched), so an expense label can never be offered for income.

## `.env` lines for the orchestrator
**None for the default behaviour.** `llm_provider` defaults to `anthropic` and `anthropic_api_key` is empty → `provider_from_settings` returns `None` → imports read `ai_status=not_configured` and behave byte-for-byte as today. Optional, for a live/QA run only: `LLM_PROVIDER=fake` (stand demo, no key), or `ANTHROPIC_API_KEY=...` (real run; the receipts/advisor key is reused), or `LLM_PROVIDER=ollama` + `OLLAMA_BASE_URL=` / `OLLAMA_MODEL=` later.

## Gates (per subtask, from `apps/api` unless noted)
`uv run ruff check . && uv run ruff format --check .` · `uv run pyright` · `uv run pytest` · (S2 only) `pnpm openapi` from the root + `pnpm turbo lint typecheck test --filter=!@budget/api` for the contract consumers (api-client drift test, web, shared) · (S2) `uv run alembic upgrade head && uv run alembic check`. Self-review via `/review-pr` is NOT skipped on S3 (STANDARD tier).

## Disagreements / flags (planned the architecture's way regardless)
1. **Merchant-only eval `text` has an accuracy ceiling.** In the raw export 8 merchants carry 2–6 different gold labels each (one grocery merchant appears under 6), because the distinguishing detail lives in the note, which the anonymizer drops. Production `text` is `display_name(merchant, description)`, so merchant-only is the honest production shape — I keep it, and the report prints an explicit **ambiguity ceiling** (`sum of per-group majority counts / N`) next to accuracy, with the group size in the owner's review table. The owner can then choose "append the note's first clause" as a v2 dataset.
2. **`categorize_model = "claude-haiku-5-5"` is an undated alias** while the repo pins dated snapshots (`anthropic_model`, `advisor_model`) for reproducibility; an alias moving under the evals would silently change the numbers. Planned as the architecture says; suggest pinning the dated Haiku 5.5 snapshot the first live run reports.
3. **Nullable enum spelled as a `"none"` sentinel** rather than `["string","null"]`/`anyOf` (architecture explicitly left the spelling open).

## Open question
- The one-line web label + i18n pair above: mine, or does S2 land with web typecheck red until the frontend scope? I plan to add it — the alternative is a knowingly red consumer gate.

## Senior-lead rulings (grooming review — these OVERRIDE the text above where they differ)
- R1. **Seeding below threshold** (S2 test list said "flagged and NOT seeded" — wrong): a VALID answer with confidence < threshold is seeded (`category_id` + `suggested_category_id`, source `llm`) AND `needs_review=true` (architecture D6). Only `"none"`/invalid/out-of-list → flagged, not seeded. The fake answers 0.9 or none, so the valid-low arm is a `test_categorize.py` case with a stub provider, not a router test.
- R2. **S2 touches NO web files.** The `llm` entry in `ImportRow.tsx`'s `SUGGESTION_KEY` and the dict keys are W1's (plan-web.md, `imports.suggestedByAi`). S2's consumer gate = `pnpm --filter @budget/api-client test` (drift) + `pnpm --filter @budget/shared test`; `@budget/web typecheck` is expected red until W1 lands and is the FINAL gate's job.
- R3. **No gold-label oracle fixture.** "Gold except every 5th" manufactures an 80% figure — the invented number the owner forbade. The replay fixture is recorded from the REAL `FakeProvider("fake")` (substring matcher). `test_evals_regression.py` asserts (i) replay accuracy == the same run executed in-process with the fake (mechanics, exact) and (ii) ≥ `EVALS_MIN_ACCURACY`, a constant whose docstring says "placeholder calibrated on the synthetic fake fixture; set from the first real run". The report/README label the number synthetic. Whatever the fake scores is the number — do not tune the fake to look good.
- R4. Disagreement 2 is moot: per docs.claude.com, dateless 5.x ids (`claude-haiku-5-5`) ARE pinned snapshots. Keep the default; say so in the config comment.
- R5. Disagreement 1 (ambiguity ceiling) accepted as planned — the owner decides v2 of the dataset from the review table.

## Risks
- An unbounded `asyncio.timeout` interaction with the FastAPI request timeout: 45 s budget + a 10/min upload limit keeps the handler bounded, but a slow provider makes the upload visibly slow — QA should time one 400-row upload against the fake.
- Alembic CHECK rebuild is the one irreversible-feeling step; the downgrade nulls `llm` suggestions and keeps `category_id`, and the suite runs `downgrade base` every session, so the path is exercised.
- The fake provider is a substring matcher: router tests must assert behaviour (source/flags/status), never the specific category it picked, or a dataset change breaks them.
