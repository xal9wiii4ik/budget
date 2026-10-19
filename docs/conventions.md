# conventions.md — cross-cutting invariants

## Money
- All amounts are INTEGER minor units (`amount_minor`); major↔minor scaling happens only at declared boundaries (receipts OCR server-side: `domain/money.py`; client input: shared parseMoney).
- Currency exponent table: default 2; exceptions exponent 0 (JPY, KRW, ISK, VND, CLP, …) and 3 (BHD, KWD, OMR, …). TWO twins — `domain/money.py` and `packages/shared/src/currencies.ts` — MUST be edited together; drift pinned by `apps/api/tests/test_currency_exponents_sync.py`.
- Never hardcode ×100; keep the `currency` argument live (100x corruption risk on exponent-0).
- FX rates and conversion math use `Decimal` (ROUND_HALF_UP), never float; rate lookup is nearest-previous-date.

## Base-currency snapshot
- Transactions store a snapshot (`base_amount_minor`, `base_currency`) computed at write time from the daily rate; aggregates read the SNAPSHOT, never re-convert.
- A user-supplied converted value is an OVERRIDE and wins over the computed one; PATCH semantics: omit=keep, value=override, null=clear/recompute. Unconvertible rows are surfaced as honest `unconverted` counts, not silently dropped.
- No `currency ?? baseCurrency` fallback in minor-unit decode (binding AM-5) — contrast test mandated.

## Scoping & 404s
- EVERY query is `user_id`-scoped; system seed rows are `user_id IS NULL` and read-only.
- No-oracle: foreign id and missing id resolve through ONE code path to a byte-identical 404 (`*_NOT_FOUND` string code). Guard order must not create an existence oracle (e.g. foreign archived category → CATEGORY_NOT_FOUND, not CATEGORY_ARCHIVED). Logout/forgot-password never reveal account existence.

## API contract
- Error `detail` is a SCREAMING_SNAKE string code; 422s declared as raw `anyOf` [domain-error schema, HTTPValidationError]; 429 body `{"detail":"RATE_LIMITED"}`.
- `apps/api/openapi.json` + `packages/api-client/src/generated/schema.d.ts` are a PAIR: regenerate with `pnpm openapi`, commit together, same commit — a drift test enforces it.
- Streaming routes (SSE /advisor/ask, CSV /transactions/export) declare `response_model=None` + `response_class` so the contract never advertises a fake JSON 200 arm.

## Seed categories
- The 18 system categories in migration `0003_seed_and_backfill.py` carry FROZEN UUID literals (e.g. Продукты `ce814749-2554-40be-8952-3a63d505694f`) — they are a contract across all environments and clients; never regenerate or re-id them.

## LLM calls (ai-layer)
- ONE provider seam for structured-output calls AND (since pdf-reconcile) bounded tool loops: `apps/api/src/budget_api/llm/` (Anthropic via GA `output_config` JSON schema for one-shot shapes, `tools`+`tool_choice` for the reconcile loop; replay keys grow only when a request carries tools; Ollama `/api/chat` `format`; fake/replay/record for tests, QA stands and evals). Receipts keep their own forced-tool-use path (image + record/reject dispatch) by decision — follow-up `receipts-on-provider`; the advisor streams text.
- Model output is NEVER trusted: `services/categorize.py` validates key membership, kind, confidence ∈ [0,1] finite, reason length; anything else = "unsure" (flagged, no category). Rules (merchant map > bank map) always win; the LLM sees only what rules left, never `exact` rows.
- Every failure degrades: an upload never 500s because of AI; untouched rows + an honest `ai_status` on the session. No operation text, prompt or exception MESSAGE ever reaches a log line — one key=value line per call (provider, model, prompt version, latency, tokens, estimated cost, user).
- The LLM never does arithmetic the server can do: the Alfa extractor returns amounts as STRINGS the server converts and checks against regex-parsed header anchors; the reconcile loop receives pre-computed amount/date deltas and only classifies/explains. Every LLM-touching import feature degrades to an honest code (`AI_NOT_CONFIGURED`/`AI_UNAVAILABLE`), never a 500.
- `PROMPT_VERSION` is a code constant pinned by a fingerprint test: edit the system prompt or the schema → bump the version and re-record replay fixtures.
- Evals numbers in README/resume only from a LIVE run; committed fixtures/reports are labeled synthetic. The anonymized dataset is committed only after the owner reviews it (`pending_owner_review` in `_meta.json`).

## Model artifacts (rag)
- A model artifact is PINNED by a manifest (`apps/api/model_manifest.json`: repo, revision, per-file sha256), fetched at BUILD time (`scripts/fetch_model.py` in its own Dockerfile stage; a build that cannot reach huggingface.co FAILS by design) and only ever VERIFIED at runtime — **never downloaded at runtime**, not lazily, not on first use. One manifest, two readers: the fetcher and `embeddings/manifest.verify` at boot. A missing or tampered artifact = one warning + the feature answers 503, never a boot failure.
- The artifact id (`<repo>@<rev7>/<file>`) is STAMPED on every row it produced, so swapping the pin invalidates the index by construction instead of by anyone remembering to clear it.
- Retrieval/embedding numbers must be LABELLED: a report from `embeddings/fake.py` (hashed bag of words) carries `synthetic: true` and a banner; a report from the real artifact carries `real: true` plus the manifest revision and sha256. Only the latter may be quoted anywhere (`apps/api/evals/README.md`).

## Process (details: memory/orchestration-policy.md, .tasks/* artifacts)
- Review tiers: FULL (code-reviewer) only for auth/security, money math, migrations, external integrations, contract changes; STANDARD = gate + QA + engineer self-review; FAST = gate + tests.
- QA cadence: qa-engineer/web-qa/mobile-qa run after implementation per checklist in `.tasks/<scope>/qa-*.md`; senior-lead reads every engineer diff before QA; PM reviews on top.
- Scope grooming once per scope (subtasks inherit); docs/ mini-docs updated by senior-lead at every scope close.
- Tests: only for genuinely breakable, uncovered behaviour (see ~/.claude/CLAUDE.md); pure logic extracted into node-testable modules instead of DOM/RN tests.
