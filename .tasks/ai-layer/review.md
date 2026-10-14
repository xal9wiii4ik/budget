# Review — ai-layer (FULL tier)

Mode: full review. Loaded rules from: `CLAUDE.md`, `~/.claude/CLAUDE.md`, `docs/conventions.md`, `code-review-senior` skill.
Intent: `.tasks/ai-layer/task.md` + `architecture.md` (A1–A3) + `plan.md` (R1–R5) + `plan-web.md`.
Read in full: `llm/*.py`, `services/categorize.py`, router diff, migration 0018, model/schema/enum/config diffs,
`evals/{anonymize,run}.py` + README + dataset + reports + fixture head, all five new test files, every web file.
Probes run (no suite): a replay-key round-trip through `build_provider(mode="replay")`, a provider raising
`RuntimeError` through `categorize`, an output-token estimate for a 20-row Russian batch, SDK/limits signatures.

## Findings

### 1. MAJOR — a replay fixture recorded from a REAL provider can never be replayed
`llm/registry.py:50-51` builds `FakeProvider(mode="replay", store_path=…)` with no `inner`, so `fake.py:72-73`
stamps `name="fake"`, `model="fake"` and `_replay` (`fake.py:138`) looks up
`request_key("fake", "fake", request)`. `_record` (`fake.py:148`) wrote the key with the INNER provider's
name/model. Probe: record via `FakeProvider("record", inner=<name="anthropic", model="claude-haiku-5-5">)`, then
`build_provider("anthropic", "claude-haiku-5-5", …, mode="replay")` → `replay_miss` on the identical request.
The committed fixture only works because fake/fake coincide; the brief's "CI regression over recorded real
answers" is broken by construction, and `test_a_recorded_answer_replays_byte_for_byte` cannot see it (inner is
the fake). Fix: `FakeProvider.__init__(…, name: str | None = None, model: str | None = None)`; registry passes
`name=provider, model=model` in replay mode. Add one round-trip test whose inner stub is named `"stub"/"stub-1"`.
(The `fake.py` docstring lines 18-20 currently claims the opposite of what the code does.)

### 2. MAJOR — `categorize()` is documented "never raises" but only catches `LLMError`
`services/categorize.py:265` (`except LLMError`). A non-`LLMError` out of a provider — the SDK raising
`TypeError`/`ValueError` on a param it does not accept, a `KeyError` in `_classify`, anything from a future
provider — propagates through `gather`, out of `categorize`, out of `_categorize_rows`, and the UPLOAD answers
500. Probe: a provider raising `RuntimeError` → `categorize` RAISED. That contradicts the invariant stated in
`architecture.md` §3, `categorize.py:9-12`, `routers/statement_imports.py:463-466` and `docs/backend.md`
("Импорт НИКОГДА не падает из-за AI"). Fix inside `run()`: a second arm
`except Exception: logger.exception("categorize batch crashed"); aborted = aborted or "error"; stop.set(); return`
(after the `LLMError` arm; `CancelledError` is `BaseException`, so the time budget is unaffected). Document the
new `aborted_reason` value. Test: the probe above as a `test_categorize.py` case.

### 3. MAJOR — output-token budget is too tight for a 20-row Russian batch
`categorize.py:71-72` (`_TOKENS_PER_ROW = 60`, floor 512) → 1200 for 20 rows. The prompt asks for ≤12-word
reasons "in the language the category names are written in" (Russian for the owner). Estimate for 20 rows with
12-word Cyrillic reasons: ~1020-1080 tokens compact; a pretty-printed answer or a model that writes 15 words
goes over. The failure is `truncated` = the WHOLE batch lost silently (`partial`, cause only in the log), while
unused `max_tokens` costs nothing. Fix: `_TOKENS_PER_ROW = 150`, `_MAX_TOKENS_FLOOR = 1024`. The comment
"one result row is ~40 tokens" is ASCII arithmetic; delete it.

### 4. MAJOR — the committed dataset carries the owner's exact salary and income tax (owner sign-off needed)
`evals/dataset/owner-categorize-v1.jsonl` rows r10/r118/r220 (`Зарплата`, 598500/608500 USD-cents) and
r3/r122/r221 (`Подоходный налог за <месяц>`, 49200/57705/60962). Names and card numbers are out, but a public
portfolio repo now states the owner's monthly net pay and tax to the cent, plus the label `Карта Поляка`.
`_meta.json` says `pending_owner_review: true` — this is exactly what that review must decide BEFORE the commit.
Suggested options: (a) bucket `amount_minor` (e.g. round to one significant digit) for every row — the model
sees "amount" as a magnitude cue only; (b) drop the three income rows and the three tax rows. Not a code defect;
listed MAJOR because the file is in the diff and the gate is the owner's eyes, nothing else.

### 5. MINOR — anonymizer: formatted phone/account numbers survive the digit-run rule
`evals/anonymize.py:82` `\d{4,}` strips `5536913812345678` but not `+375 29 123 45 67` or `BY12 ALFA 3012 …`
(runs of 2-4 with separators). Fix: add `re.compile(r"(?:\+?\d[\s\-()]?){7,}")` to the strip set. The
person-name pattern (`:131-136`) is Cyrillic-only — a Latin "John Smith" merchant is kept; acceptable given the
owner review, but say so in the docstring. Also `tests/test_evals_anonymize.py:74` `Оскин Михаил` — confirm this
is an invented name; the file promises synthetic rows and a real one would defeat the point.

### 6. MINOR — `truncated` arm is untested end-to-end
`llm/structured.py:35` and `ollama.py:142` (`done_reason: "length"` → `max_tokens`) have no test; a regression
there turns a cut-off answer into `invalid_output`/a half-parsed dict. One `test_llm_providers.py` case: Ollama
body with `done_reason: "length"` → `structured` raises `truncated`. (Anthropic `stop_reason: "max_tokens"` is
the same code path through `structured`, no second test needed.)

### 7. MINOR — the quota closure is never exercised through the limiter
`routers/statement_imports.py:404-435` is the only line that calls `limiter.limiter.hit(item, key, cost=rows)`
(`pat_auth` uses the no-cost form); every router test runs with `rate_limit_enabled=False`, so a wrong kwarg or
a wrong key would ship green. One test: `make_llm_client(rate_limit_enabled=True, categorize_daily_row_quota="1/day",
categorize_batch_size=1, categorize_concurrency=1)`, upload two eligible rows → `ai_status=partial`,
second row untouched. (`limits 5.8.0` does accept `cost=`; verified by signature.)

### 8. MINOR — a user with NO category of a row's kind reads `failed`, not `skipped`
`_categorize_rows` (`:477` and `:543`): eligibility is decided before categories are loaded; if every eligible
row's kind has zero non-archived categories, `_plan` builds no batches, `results == {}` → `failed` with no log
line and no call. With the 18 seed categories this needs archiving every income category, so rare — but
`failed` is a lie there. Fix: after `_plan` returns no batches, return `skipped` (expose it via
`CategorizeOutcome` or check `by_kind` coverage in the router).

### 9. NIT — file-level `# ruff: noqa: RUF001 RUF003` vs the pyproject precedent
`tests/test_statement_imports_ai.py:26`. The same diff already adds two per-file-ignores to `pyproject.toml:85-86`
for `evals/anonymize.py` and its test; the in-file comment's reason ("that file belongs to a subtask being
written in parallel") no longer holds. Move it to `pyproject.toml` and drop lines 19-26.

### 10. NIT — web: dead fallbacks on now-required fields
`routes/ImportPage.tsx:233` `session.ai_rows_flagged ?? 0` and `features/imports/ImportRow.tsx:158`
`row.needs_review === true` — after regen both fields are non-optional; the shim is gone (good — the blank line
left at `data/imports.ts:45` is its residue). Simplify to `session.ai_rows_flagged` / `row.needs_review`; if the
web lint runs `no-unnecessary-condition` it will say the same.

### 11. NIT — unrelated working-tree changes are in `git status`
`.claude/scheduled_tasks.lock` (deleted), `skills-lock.json`, `.claude/skills/grill-me/`, `.claude/skills/grilling/`,
`.tasks/ai-portfolio.md`, `.tasks/pdf-reconcile/` — none belong to this scope's commit. Orchestrator: stage by path.

### Verified, no finding
- Anthropic wire shape (`anthropic.py:75-98`): `system=[{text, cache_control: ephemeral}]`,
  `output_config={"format":{"type":"json_schema","schema":…}}`, no `temperature`, `max_retries=1`; SDK 0.120.0
  accepts `output_config` (checked by signature). `_classify`: 429/5xx/no-status → `unavailable`, other 4xx →
  `request_rejected` logging status + class name only. No prompt/operation text in any log line (`usage.py:93-107`,
  `_classify`, router `:532-537`, registry). Ollama `/api/chat` body matches the documented shape.
- Validation (`categorize.py:422-508`): unknown key dropped, duplicate key first-wins, missing row → unsure(0.0),
  wrong kind backstopped via GLOBAL `c*` keys, bool/NaN/out-of-range → unsure, reason stripped + cut at 300.
  Dedupe key computed once (`:343-347`), twins fan out, cap counts uniques. Time budget leaves partial `results`
  intact (cancel lands inside `await structured`, writes are synchronous after it).
- Router: rules-first + `exact` excluded + archived excluded (`Category.archived.is_(False)`), `profile.country`
  read as the column, pass computed BEFORE the `try` so the IntegrityError retry reuses the same `ai`, `_seed`
  per R1 (valid-low = seeded + flagged), PATCH clears `needs_review` only inside the `category_id` branch
  (`:1348`), `?needs_review=` in `filters` used by both count and page, counts at read in both `_counts` and
  `_counts_of`. No-oracle 404 paths untouched. No MCP markers added.
- Migration 0018 vs model: `_values` renders `'a', 'b'` with `", "`; both CHECK strings byte-identical to the
  model's; enum append-only; downgrade NULLs `suggestion_source`/`suggested_category_id` and keeps `category_id`;
  server defaults on both NOT NULL columns. `openapi.json` + `schema.d.ts` carry the same fields, the
  `needs_review` query param and `llm` in `StatementSuggestionSource`.
- Evals: `run.py` calls the production `categorize` with `Settings` field DEFAULTS (not `Settings()`, good —
  `.env` cannot move the replay key); R3 holds (replay == in-process fake, `EVALS_MIN_ACCURACY` docstring says
  placeholder, replay miss raises `EvalError`); README/report/fixture header all say synthetic; no invented
  real-model numbers anywhere.
- Web: no money math, confidence never rendered, `ai_reason` verbatim (not through `translateBankText`), 11 new
  keys present in BOTH dicts with 4 RU plural forms, `satisfies Record<…>` map carries `llm`, `ImportRow` props
  unchanged (memo intact), chip AND semantics with `needs_review` sent only when true, `role="status"` only on
  `warning`, bulk block hidden under the chip, CSS tokens only (the `1px` border follows `.badgeUntranslated`).
- Tests: none vacuous or duplicated; the router file deliberately never asserts WHICH category the fake picked.

## What is good
- The provider seam is genuinely app-free and the fake lives in `src/`, so one `app.state.llm` swap covers router
  tests, the QA stand and the evals CLI — no second fake anywhere.
- Degradation is designed end to end: absent key = untouched row, status without a stored cause, pass before the
  write so the retry is free; `_seed` puts all three category sources in one readable function.
- The evals honesty rules are real, not decorative: prompt-version refusal, loud replay miss, synthetic labels on
  every artifact, and a placeholder threshold that admits what it is.

## Verdict
**Apply findings 1-3 before commit** (1 and 2 are small, 3 is a constant); **finding 4 needs the owner's explicit
OK or a bucketing pass on the dataset before it is committed**. 5-8 are worth doing in the same pass; 9-11 are
nits for the orchestrator. No blocker in the shipped path when AI is not configured — the default server is
byte-for-byte unchanged.
