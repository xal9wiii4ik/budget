# Task: core-data-model (roadmap 1.2)

Verbatim PM brief:

TASK (id: `core-data-model`, roadmap item 1.2): The core domain tables + migrations. State: HEAD 19f4e36 — auth done (users + refresh_tokens at migration 0001), naming convention proven, current_active_user dependency canonical.

Scope per roadmap 1.2 and the architecture doc's data model table:
- `profiles`: user_id PK/FK, base_currency (char3, validate against shared CURRENCY_CODE_PATTERN philosophy), monthly_income_minor nullable. Creation strategy: auto-create on register (hook) vs lazy vs backfill migration for existing users — decide; the 1.1 carry-forward demands existing users get one.
- `categories`: id, user_id NULLABLE (null = system category), name, icon, color?, kind (expense|income — enum decision: PG enum vs varchar+check), archived bool. System seed set (архитектура: продукты, транспорт, жильё, здоровье и т.д.) — decide the exact seed list and HOW it ships (data migration vs startup idempotent seed vs fixture).
- `transactions`: per the architecture's SQLAlchemy sketch — id, user_id FK indexed, amount_minor BigInteger, currency String(3), category_id FK nullable, occurred_at date, note nullable, receipt_id nullable (receipts table is stage 2 — decide: create the column now without FK, with a deferred FK, or omit until 2.x; surface the tradeoff), created_at server default; composite index (user_id, occurred_at) per architecture.
- Migrations: 0002+ chain on 0001; empty-autogenerate check stays green; downgrade path tested.
- NO endpoints in this task per PLAN 1.2 (CRUD APIs are 1.3/1.4) — but DECIDE and justify whether pure-model tasks warrant a thin repository/domain layer now or endpoints-first later; the architecture's domain/ layer contract exists since 0.2.
- Amount sign convention: architecture says amount stores magnitude with sign implied by category kind (shared parseMoney rejects negatives) — but transfers/refunds and uncategorized transactions (category_id nullable!) stress this. Decompose properly per Phase 3.5: where does the sign live for an uncategorized transaction? This is THE design question of the task — do not bury it.
- Tests: model-level round-trips, constraint behavior (FK cascade decisions per table — decide each explicitly), migration cycle. pytest-conventions apply.

Team: architect (three tables, seed strategy, sign convention — clearly structural), backend-engineer, qa-engineer (migration/constraint live checks; no endpoints so scope is narrower — justify the shape of QA here). frontend/mobile not needed (no client changes, no schema-visible API change EXCEPT if you decide the openapi contract changes — it should NOT in this task; state that explicitly).

Binding carry-forwards for THIS task (from 1.1 grooming-review §7 + meta-review §4):
(a) profiles table deferred from 1.1 to here WITH backfill obligation for existing users;
(b) turbo.json env quirk needs a groomed one-line decision (`env: ["TEST_DATABASE_URL"]` on @budget/api#test — root file, backend owns);
(c) root-file ownership = backend-engineer;
(d) per-amendment checklist in implementation reports;
(e) both contract artifacts regenerate/commit together when the schema changes;
(f) local Postgres 5443 via TEST_DATABASE_URL, committed contract 5433.

Process notes from the PM: proceed without waiting; artifacts to .tasks/core-data-model/; Phase 4 with per-amendment checklist. Return: team + reasoning, artifact paths, open questions with recommendations. Do NOT start implementation.
