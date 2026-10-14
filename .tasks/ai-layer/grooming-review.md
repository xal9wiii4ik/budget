# Grooming review: ai-layer (PLAN.md 7.1)

Team: architect (new `llm/` package, migration 0018, contract shape, provider seam reused by
`pdf-reconcile`), backend-engineer (plan.md), frontend-engineer (plan-web.md), qa-engineer
(FULL-tier stop-probes + checklist). Excluded: mobile-engineer/mobile-qa (mobile frozen, no
import screen), web-qa at grooming (coverage map comes from the lead; web-qa executes at the end).

## Artifacts
- `architecture.md` — adopted with amendments A1 (`ollama_model`), A2 (`?needs_review=` + chip), A3 (regression eval = ordinary pytest).
- `plan.md` — adopted with rulings R1–R5 (seeding below threshold, S2 touches no web files, no oracle fixture, `claude-haiku-5-5` is a pinned id, ambiguity ceiling kept).
- `plan-web.md` — adopted (render `aiSkipped`; ≤6 helper tests; in-place PATCH under the filter is expected).
- `qa-checklist.md` — qa-engineer (FULL stop-probes with the fake provider; live full run once at scope end).

## Subtasks and tiers
| id | what | tier | why | depends on |
|---|---|---|---|---|
| S1 | `llm/` providers (Anthropic structured outputs, Ollama, fake/replay/record) + `services/categorize.py` + settings | FULL | external integration | — |
| S2 | statement-import integration: migration 0018, enums/models/schemas, upload LLM pass, quota, `_counts`, PATCH clears flag, `?needs_review=`, `app.state.llm`, contract pair regen | FULL | migration + contract change | S1 |
| S3 | `apps/api/evals/`: anonymizer, dataset (PENDING OWNER REVIEW), runner, fake replay fixture, regression test, README | STANDARD | no money/auth/contract; self-review via /review-pr | S1 |
| W1 | web preview: `llm` source label + reason, "check category" badge, chip + `needs_review` in the key, `ai_status` line, RU+EN | STANDARD | screen work inside a groomed contract | contract thesis (types shim until S2 regen) |

Order: S1 → (S2 ∥ S3 ∥ W1). W1 starts at once against the contract thesis. Pytest runs are
serialized (S2 and S3 never run the full suite at the same time; S3's tests need no DB).

## Decisions worth restating (one line each)
- Categorize goes through Anthropic STRUCTURED OUTPUTS (`output_config`, GA), not tool-use; receipts keep forced tool-use for a stated reason (image + two-way dispatch) — follow-up `receipts-on-provider` carded by the orchestrator.
- Model: `categorize_model` = `claude-haiku-5-5` (Haiku 4.5 legacy from 2026-10-15; 10x cheaper; dateless 5.x ids are pinned snapshots). Receipts' `anthropic_model` untouched.
- Inline pass in the upload, 45 s budget, per-kind batches of 20, concurrency 4, dedupe, 400-row cap, per-user daily row quota via a direct limiter hit; every failure degrades to untouched rows + an honest `ai_status`.
- Below-threshold valid answer → seeded AND flagged; null/invalid → flagged, not seeded; the learning gate (`category_user_set`) is unchanged.
- No log table: one key=value `logger.info` per call with provider/model/prompt/latency/tokens/cost, never text.
- Evals: fixtures from the real fake provider, labeled synthetic; NO real-model numbers until a live run; anonymized dataset shown to the owner before commit.

## Estimates (agent-minutes, write / gates / verification)
S1 70/15/15 · S2 60/25/15 · S3 50/10/15 · W1 50/10/10 · plus one fix round if QA finds a functional defect.

## Env / infra
- No `.env` lines for default behaviour. Stand only: `LLM_PROVIDER=fake` (deterministic name-match). Stand ports: API 8021, vite 5199.
- `pyproject.toml`: `pythonpath = ["."]` + `evals` in pyright include (S3).
