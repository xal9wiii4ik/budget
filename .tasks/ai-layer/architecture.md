# Architecture Plan: ai-layer — LLM categorization behind one provider seam

## Context
Rules (`services/statement_import/categories.py`: merchant map > bank map) leave most rows of a first import uncategorized. This scope adds an LLM pass for exactly those rows, behind ONE provider abstraction that a later scope (`pdf-reconcile`: long-text extraction + a small tool loop) reuses without redesign, and that an evals CLI can drive with no app and no DB. Two Anthropic call sites already exist (receipts: forced tool-use over an image; advisor: streaming text) — neither is a "one fixed JSON shape over text" seam, which is what categorize and the PDF extraction need.

## Proposed approach
1. `llm/` — provider protocol + Anthropic (structured outputs), Ollama (`/api/chat` with `format=<schema>`), Fake/Replay; settings-only, constructed once onto `app.state.llm` (`None` = not configured).
2. `services/categorize.py` — pure: operations + categories → per-operation results + usage. Prompt v1 and schema live here; validation, kind filter, dedupe, batching, time budget, quota hook.
3. The upload route runs the pass INLINE between `suggest_categories` and `_store_preview`, only over rows where rules found nothing and `match_status != exact`, and hands the results into `_build_rows` as data. Everything that can go wrong degrades to "untouched rows + honest `ai_status`"; the import never fails because of AI.
4. Rows get `ai_confidence` / `ai_reason` / `needs_review`; the session gets `ai_status` + provider/model/prompt stamps; `suggestion_source` gains `llm`. No new endpoints; `StatementRowRead` / `StatementImportRead` grow fields.
5. Receipts and advisor stay as they are (deliberate, see Trade-offs).

## The provider interface (`llm/`)
Frozen dataclasses, no pydantic (the evals CLI must not care about the API layer):

- `LLMRequest(system: str | None, messages: tuple[Message, ...], output_schema: dict | None, max_tokens: int, tools: tuple[ToolSpec, ...] = (), tool_choice: str | None = None)`. `Message(role, content: tuple[TextPart | ToolResultPart, ...])`.
- `LLMResponse(blocks: tuple[TextBlock | ToolUseBlock, ...], stop_reason: str, usage: Usage)`.
- `Usage(provider, model, input_tokens, output_tokens, cache_read_tokens, latency_ms, estimated_cost_usd: Decimal | None)`.
- `class LLMProvider(Protocol): name: str; model: str; async def complete(self, request: LLMRequest) -> LLMResponse`.
- `llm/structured.py: async def structured(provider, request, schema) -> tuple[dict, Usage]` — sets `output_schema`, takes the first `TextBlock`, `json.loads`; non-JSON → `LLMError("invalid_output")`; `stop_reason == "max_tokens"` → `LLMError("truncated")`. Pydantic/domain validation of the dict belongs to the caller (categorize), not here.

**v1 (implemented):** `complete` with text messages + `output_schema`; `structured()`. **Reserved shape (declared, not implemented):** `tools`, `tool_choice`, `ToolUseBlock`, `ToolResultPart`. A v1 provider receiving `tools` raises `LLMError("unsupported")`. Why declare them now: the pdf-reconcile loop is "call → read `ToolUseBlock`s → append `ToolResultPart`s → call again", which is a loop over this exact request/response shape; long-text extraction is `structured()` with a big user message plus the `truncated` arm. Neither needs a new method. The agent loop itself is the later scope's module.

Error taxonomy — one `LLMError(code: str)` with `retryable` derived from the code:
`unavailable` (connect/timeout/429/5xx/529 — retryable), `request_rejected` (other 4xx: bad key, bad schema — not retryable, logged WARNING), `invalid_output`, `truncated`, `unsupported`, `replay_miss` (replay mode only). "Not configured" is NOT an error: `registry.build_provider` returns `None`.

Providers: `anthropic.py` — `AsyncAnthropic(api_key, timeout=llm_timeout_seconds, max_retries=1)`, `messages.create(..., system=[{text, cache_control: ephemeral}], output_config={"format": {"type": "json_schema", "schema": ...}})`, no temperature (Haiku 5.5 rule), the receipt_parser catch tuple → `unavailable`/`request_rejected`. `ollama.py` — `POST {ollama_base_url}/api/chat` `{model, messages, format: schema, stream: false, options: {temperature: 0}}`; `message.content` → one `TextBlock`; `prompt_eval_count`/`eval_count` → tokens, `total_duration/1e6` → latency; cost `Decimal(0)`; `httpx.ConnectError`/`TimeoutException`/HTTP ≥ 400 → `unavailable` (an unreachable localhost is a call-time fact, degrade, never a boot failure). Both take an optional `http_client: httpx.AsyncClient` kwarg (the recorded-response test seam; `AsyncAnthropic(http_client=...)` supports it natively).

`registry.py`: `build_provider(provider, model, *, api_key="", ollama_base_url, timeout, replay_path="", mode="fake") -> LLMProvider | None` with explicit args (the CLI calls this), plus `provider_from_settings(settings)` (app.py calls this). "Configured" = `anthropic` with a non-empty key, or `ollama`, or `fake`; `off` or keyless anthropic → `None`.

`usage.py`: `PRICES_USD_PER_MTOK` — `{"claude-haiku-5-5": (0.10, 0.50), "claude-haiku-4-5-20251001": (1.0, 5.0), "claude-sonnet-5-5": (2.0, 10.0), "claude-sonnet-4-5-20250929": (3.0, 15.0)}` with an "as of 2026-10-14, docs.claude.com pricing" note; cache-read tokens at 0.1× input; unknown model → `None` (never 0 — 0 is Ollama's honest number). `estimate_cost(model, usage) -> Decimal | None` (6 places; not ledger money, Decimal only to keep logs clean). `log_call(usage, *, prompt_version, outcome, batch_size, user_id)` emits ONE `logger.info` as key=value text (the project's formatter prints no `extra`): `llm call provider=anthropic model=claude-haiku-5-5 prompt=categorize-v1 outcome=ok|error:<code> batch=20 latency_ms=812 in=1431 out=388 cache_read=0 cost_usd=0.000337 user=<uuid>`. Never operation text, never the prompt. This line IS the call record (brief: no log table).

`fake.py`: ONE class `FakeProvider(mode, store_path)`:
- `fake`: parses the user message's JSON data section (see prompt layout below), answers per operation: the first category (of the operation's kind) whose name is a case-insensitive substring of the text → that key, 0.9, "name match"; else `null`, 0.2; text containing `LLMFAIL` → `LLMError("unavailable")`. Usage: zero tokens, cost 0, latency measured. Usable on a live QA stand via `LLM_PROVIDER=fake`.
- `replay`: JSONL store keyed by `sha256(canonical JSON of {provider, model, system, messages, output_schema, max_tokens})`; miss → `LLMError("replay_miss")`. `record`: wraps a real provider and appends `{key, response, usage}`. Fixtures: `apps/api/evals/replay/<provider>-<model>-<prompt_version>.jsonl` (committed; the anonymized dataset lives under `apps/api/evals/dataset/`). Replay/record are built only by the evals CLI, never by `provider_from_settings`.

## The categorize service (`services/categorize.py`)
Inputs: `Operation(key, text, amount_minor, currency, country: str | None, kind)` (text = `types.display_name(merchant, description)` — the same string the merchant map is keyed by), `CategoryOption(id, name, kind)`, `CategorizeConfig(threshold, batch_size, concurrency, time_budget_seconds, max_rows)`, `quota: Callable[[int], bool]` ("may I spend n rows?" — the router passes a limiter closure, the CLI passes `lambda n: True`). Output: `CategorizeOutcome(results: dict[key, CategorizeResult], calls: list[Usage], aborted_reason: str | None)` where `CategorizeResult(category_id | None, confidence: float, reason: str | None, needs_review: bool)`.

- `PROMPT_VERSION = "categorize-v1"` — a module constant; bump on ANY change to the system text or the schema (the module docstring is the changelog). Stamped on the session and in every log line; the evals report is keyed by it.
- Prompt layout: system = instructions (fixed text, `cache_control` on it — harmless under the cache minimum); user message = ONE JSON document `{"categories": [{key, name, kind}], "operations": [{key, text, amount, currency, country, kind}]}`. JSON rather than prose because the fake provider and the replay key both need a machine-readable request, and it costs the real model nothing.
- Keys: categories sorted by (kind, name, id) → `c1..cN`; operations `o1..oM` per batch. Deterministic order is what makes the replay hash stable.
- Batches are formed PER KIND (expense ops with expense categories, income with income): the schema's `category` enum is then exactly the eligible keys, the strongest constraint available; the server-side kind check stays as the backstop. Schema: `{results: [{key: enum(o*), category: enum(c*) | null, confidence: number, reason: string}]}`, `additionalProperties: false` everywhere, no min/max (validated server-side).
- Validation per result: key known; category `None` → unsure; category compared case-insensitively against the batch's keys, wrong kind or unknown → unsure; confidence finite and in [0,1] else unsure; reason stripped, cut to 300 chars. Unsure = `category_id None, needs_review True, reason None`. Valid → `needs_review = confidence < threshold`. A missing key → unsure. A whole batch that is not parseable → `invalid_output` → those operations are simply absent from `results` (untouched rows), other batches continue.
- Dedupe BEFORE batching on `(text.casefold(), kind, currency)`; the representative carries the first occurrence's amount; every duplicate receives a copy of the result. Then the row cap: unique operations beyond `max_rows` are untouched.
- Scheduling: batches in file order, `asyncio.Semaphore(concurrency)`, the whole gather under `asyncio.timeout(time_budget_seconds)`; cancelled batches = untouched rows. `quota(len(batch))` is asked right before each call; a refusal, an `unavailable` or a `request_rejected` ABORTS the remaining batches (a dead provider or an exhausted user must not be hammered 20 more times) and sets `aborted_reason`; `invalid_output`/`truncated` do not abort.
- Pure: imports `llm`, `domain`, `enums`, stdlib — never `models`, `db`, `fastapi`, the limiter. This is the module `apps/api/evals/` imports.

## Router integration (`routers/statement_imports.py`, upload only)
Order: account → size → format → parse → currency → fingerprints → matching → rules (`suggest_categories`) → **LLM pass** → `_store_preview`. The pass is computed once and reused by the IntegrityError retry exactly like `suggestions`. Eligible rows: `suggestion is None and match_status != exact`. The router loads the user's visible non-archived categories (one query, the receipts `CategoryOption` precedent) and `profile.country` (one read, nullable), builds the `Operation`s, and owns the quota closure: `limiter.limiter.hit(item, f"{scope}:categorize:{user_id}", cost=n)` over `parse_many(settings.categorize_daily_row_quota)` (pat_auth precedent; a failed batch is not refunded). `_build_rows` gains an `ai: Mapping[row_index, CategorizeResult]` argument; `_store_preview` stamps the session.

Row seeding from a result: valid → `suggested_category_id = category_id = <id>`, `suggestion_source = 'llm'`, `category_user_set = False`, `ai_confidence`, `ai_reason`, `needs_review` as computed; unsure → no category, `needs_review = True`, `ai_confidence` stored, `ai_reason = NULL`; absent (failed/cancelled/capped) → row untouched, `needs_review = False`. The learning gate is unchanged: an LLM seed teaches the maps nothing until the user confirms it with a PATCH.

`ai_status` (String(16), CHECK, enum `StatementAiStatus` appended in this order): `not_configured` — `app.state.llm is None`; `skipped` — provider present, zero eligible rows; `ok` — every eligible row got a result (valid or unsure); `partial` — some did, the rest were untouched (budget, cap, quota mid-way, an aborting error, an unparseable batch); `failed` — eligible rows existed and none got a result (provider down, quota exhausted before the first call). The CAUSE lives in the log line, not on the session — deliberately coarse; see "does not decide". `ai_provider`/`ai_model`/`ai_prompt_version` are set whenever a provider exists (also for `skipped`/`failed`), NULL for `not_configured`.

PATCH on a row: a body carrying `category_id` (value OR explicit null) sets `needs_review = False` — the user looked; `decision`-only PATCH and bulk-decision leave it alone. `ai_confidence`/`ai_reason` are never cleared (they record what the model said). `needs_review` does not block apply or replace.

Counts `ai_rows_suggested` (= rows with `suggestion_source = 'llm'`) and `ai_rows_flagged` (= rows with `needs_review`) are COUNTED AT READ in `_counts`, like `by_match_status`: a stored counter would go stale on the first PATCH, and "how many still need a look" is the live number the screen wants.

`ai_confidence` on the wire: `float | None`. It is not money and no client arithmetic is involved beyond display; `transfer_rate` is a string because it is a rate applied to money — this is not. Stored `Numeric(4,3)` only so the column is bounded.

## Database changes (migration `0018_statement_ai.py`)
### Tables
- `statement_imports` (ALTER): `ai_status` String(16) NOT NULL server_default `'not_configured'` + CHECK `ai_status_valid`; `ai_provider` String(32) NULL; `ai_model` String(64) NULL; `ai_prompt_version` String(32) NULL. Existing sessions honestly read `not_configured`.
- `statement_import_rows` (ALTER): `ai_confidence` Numeric(4,3) NULL; `ai_reason` String(300) NULL; `needs_review` Boolean NOT NULL server_default `false`. CHECK `suggestion_source_valid` DROPPED and recreated under the SAME NAME with `('merchant','bank_category','llm')` — `llm` is APPENDED to `StatementSuggestionSource` (the 0012 `ck_accounts_type_valid` precedent; alembic cannot diff CHECKs on an existing table). No new index: every read is `WHERE import_id = ?`, already indexed.

### Migration steps
1. ADD the four session columns, then `ai_status_valid`.
2. ADD the three row columns.
3. DROP `suggestion_source_valid`, CREATE it with three values.
4. Downgrade: `UPDATE statement_import_rows SET suggestion_source = NULL, suggested_category_id = NULL WHERE suggestion_source = 'llm'` (keep `category_id` — it is the apply value the user saw), rebuild the two-value CHECK, drop the columns, drop `ai_status_valid`, drop the session columns.
5. Settings (all with defaults — the explicit `Settings(...)` sites): `llm_provider` `anthropic|ollama|fake|off` = `anthropic`; `categorize_model` = `claude-haiku-5-5` (also the Ollama model name when that provider is chosen — one knob, meaning depends on provider); `ollama_base_url` = `http://localhost:11434`; `llm_timeout_seconds` = 30; `categorize_confidence_threshold` = 0.7; `categorize_batch_size` = 20; `categorize_concurrency` = 4; `categorize_time_budget_seconds` = 45; `categorize_max_rows_per_import` = 400; `categorize_daily_row_quota` = `3000/day`. `anthropic_api_key` is reused; `anthropic_model`/`advisor_model` untouched.

## Module structure
```
llm/            __init__.py (re-exports), types.py, errors.py, structured.py,
                anthropic.py, ollama.py, fake.py, registry.py, usage.py
services/categorize.py
routers/statement_imports.py   (upload: LLM pass + quota closure; PATCH: needs_review)
schemas/statement_import.py    (+ fields), enums.py (+ llm, StatementAiStatus)
models/statement_import.py, alembic/versions/0018_statement_ai.py
app.py: app.state.llm = provider_from_settings(resolved)   # may be None
apps/api/evals/  (anonymizer, dataset/, replay/, runner — engineer's design)
```
Contract: `StatementRowRead` + `ai_confidence`, `ai_reason`, `needs_review`; `StatementImportRead` + `ai_status`, `ai_provider`, `ai_model`, `ai_prompt_version`, `ai_rows_suggested`, `ai_rows_flagged`; `StatementSuggestionSource` + `llm`; new `StatementAiStatus`. `openapi.json` + `schema.d.ts` in one commit. MCP: unchanged — the nine statement-import routes carry no marker and stay unreachable by token; no tool text to update.

Dependency direction: routers → services/categorize → llm. `llm/` imports `config`, `httpx`, `anthropic`, stdlib only. `services/categorize.py` imports `llm`, `domain`, `enums`, stdlib — never `models`/`db`/`fastapi`/`rate_limit`. The router owns every DB write and the limiter. `evals/` imports `llm.registry` + `services.categorize` and nothing else from the app.

## Trade-offs considered
- **Structured outputs vs forced tool-use for categorize:** structured outputs — GA, no beta header, the forward-compatible path (`tool_choice: any` already 400s on the newest families), and a schema enum is a stronger guard than a tool description. Receipts KEEP forced tool-use: an image input and a two-way dispatch (record vs reject) is genuinely two tools, with its own fake seam and failure codes wired into the receipts state machine. Deliberate deviation; follow-up `receipts-on-provider`: move receipts onto `llm/` once the evals have proven the provider (adds `ImagePart` to `Message` — the shape slot exists). Advisor stays streaming text — out of scope.
- **Inline vs background job:** inline under a 45 s budget. A job needs a status column, polling and a second screen state; the preview already is the review step, and a bounded wait on an explicit upload is acceptable. Revisit only if real files exceed the budget routinely.
- **Fake provider at the provider level vs a fake categorize service:** provider level, enabled by the JSON user message. One seam (`app.state.llm`) covers router tests, QA stand and evals; a fake categorize would leave the real provider code untested by the suite.
- **Batches per kind vs mixed:** per kind — the enum does the filtering, the server check is a backstop rather than the only guard.
- **Counts stored vs read:** read (above). **Reason on the session for `failed`/`partial`:** not stored — one coarse status plus the log; a `quota_exceeded`-style value is a one-line enum append + CHECK rebuild if the screen turns out to need it.
- **Quota as callback vs limiter inside the service:** callback — keeps categorize importable without the app, and keeps the limiter's "direct hit" trick in the one file that already does it.
- **Fingerprints:** unaffected by construction — the canon never included categories; idempotency does not move.

## Test seams
1. `app.state.llm` swap (`FakeProvider("fake")` or `None`) — the receipt_parser precedent; router tests: name-match rows get `source=llm` + seeds, `LLMFAIL` rows untouched with `ai_status=partial`, `off` → `not_configured`, PATCH clears `needs_review`, counts at read.
2. `services/categorize` unit tests with the fake: out-of-list / wrong-kind / confidence > 1 / missing key → unsure; dedupe (calls = ceil(unique/batch)); time budget with a sleeping provider → partial; quota refusal → abort; unparseable batch → untouched, others continue.
3. Providers with recorded HTTP bodies via `http_client=httpx.AsyncClient(transport=httpx.MockTransport(...))`: Ollama happy path + ConnectError → `unavailable`; Anthropic `output_config` wire shape + 429/529 → `unavailable`, 400 → `request_rejected`. No live calls anywhere in the suite.
4. Enum-order/CHECK byte-identity test for the rebuilt `suggestion_source_valid` and the new `ai_status_valid` (existing pattern).
5. CI evals replay: runner with `mode=replay` over `evals/replay/*.jsonl` against the accuracy threshold; a `replay_miss` fails the run loudly.

## Senior-lead amendments (grooming, 2026-10-14)
- A1. `ollama_model` is its OWN setting (default `llama3.1`), not `categorize_model` reused: with one knob, `LLM_PROVIDER=ollama` would ask Ollama for `claude-haiku-5-5` and every call would degrade — a silent misconfiguration. `registry.provider_from_settings` picks the model by provider.
- A2. `GET /statement-imports/{id}/rows` gains an optional `needs_review: bool | None` query filter (combinable with `match_status`); the web adds a "check category (N)" chip fed by `ai_rows_flagged`. One WHERE clause; no new endpoint. The contract pair carries it.
- A3. The evals regression test is an ordinary pytest test (`tests/test_evals_regression.py`), so the `ci-readme` scope's workflow runs it with no extra wiring.

## What this does NOT decide
- The evals runner design (dataset format, anonymizer rules, report layout, threshold value) — backend engineer; only the imports it uses are fixed above.
- The exact system-prompt wording of `categorize-v1` and the JSON-schema spelling of the nullable enum (subject to the schema rules in the brief).
- Whether `GET /{id}/rows` gets a `?needs_review=` filter — a frontend-plan ask; adding a query param is allowed within "no new endpoints" if the preview needs it.
- Web rendering of the flag, the reason and `ai_status` copy (ru/en); the mobile app stays frozen.
- Whether `partial`/`failed` need a stored cause — revisit after the first real run.
- Default numeric values above are starting points; the evals run may move threshold and batch size.
