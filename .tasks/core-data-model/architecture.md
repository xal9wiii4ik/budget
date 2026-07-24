# Architecture Plan: core-data-model (roadmap 1.2)

## Context

Three core tables (`profiles`, `categories`, `transactions`) join `users` /
`refresh_tokens` (migration 0001). This task defines the schema that 1.3
(categories API), 1.4 (transactions API + monthly summary), and every later
aggregate (4.1) will query. The single load-bearing design question is the
amount sign convention (§1); everything else is careful application of
already-established conventions (naming-convention `Base`, native `Uuid`,
tz-aware `created_at` with server defaults, migration chain on 0001,
empty-autogenerate gate).

Everything below was verified against the actual code at HEAD (models/base.py,
models/user.py, models/refresh_token.py, auth.py, db.py, tests/conftest.py,
alembic/versions/0001, alembic/env.py, packages/shared/{currencies,money,schemas}.ts),
not from memory. Facts cited as "verified" name their source.

**Scope contract**: DESIGN of tables + migrations 0002/0003 + seed + backfill.
NO endpoints. **The OpenAPI contract does NOT change in this task**: no files in
`schemas/` or `routers/` are touched, `openapi.json` and `packages/api-client`
stay byte-identical (carry-forward (e) is therefore *not triggered* — nothing to
regenerate; QA should assert the artifacts are unchanged).

---

## 1. THE headline question: where does the amount sign live?

Constraints that frame this, all verified:

- `packages/shared/src/money.ts`: `parseMoney` **rejects** a leading `-`
  (`error: 'negative'`) — "the amount field carries magnitudes only".
  `toInputString` (edit-form prefill) **throws** on negative minor. Clients
  never type or round-trip a sign.
- `transactions.category_id` is **nullable** (uncategorized transactions are a
  legal state), so "sign implied by category kind" (architecture doc §2) has a
  hole: an uncategorized transaction has no kind source.
- Stressors: refunds (money back against an expense category), future
  transfers (stage 5 candidate), and re-categorization across kinds.

### Option (a) — signed `amount_minor` as source of truth

Expense rows stored negative, income positive.

- Summary SQL (1.4): net = `SUM(amount_minor)`; expenses =
  `SUM(amount_minor) FILTER (WHERE amount_minor < 0)`. Clean.
- Uncategorized: sign is explicit in data. Refunds: a positive row in an
  expense category nets naturally. Good semantics.
- Re-categorization: moving a −500 row to an income category leaves a
  "negative income" unless the write path flips the sign — a write-time
  invariant living only in application code, exactly the drift risk we want
  the schema to kill.
- Client impedance mismatch is permanent: every read for edit needs `abs()`
  (or `toInputString` throws — verified guard), every write must combine a
  UI kind-toggle with a sign the user never typed. The API would either
  expose signed values (clients must know the convention) or expose
  magnitude+kind and map to sign at the boundary — at which point the DB
  stores something different from every contract above it.
- CHECK constraints: none available to express "sign matches intent" —
  the DB cannot tell a refund from a data bug.

### Option (b) — magnitude + non-null `kind` column ON transactions

`amount_minor >= 0` (CHECK), `kind IN ('expense','income')` NOT NULL,
denormalized from the category at write time but owned by the transaction.

- Survives `category_id = NULL` (uncategorized keeps an explicit kind) and
  survives `ON DELETE SET NULL` (§6) without losing meaning.
- Matches the shared contract exactly: magnitudes end-to-end, zero
  `abs()`/sign-mapping at any layer; `parseMoney`/`toInputString` round-trip
  is the storage value.
- Refunds: representable as `kind='income'` referencing an expense category
  (netting handled in SQL, below) — provided we do NOT constrain
  `tx.kind == category.kind` (position taken in §6).
- Re-categorization: `kind` does not silently flip; if the user moves a row
  into an other-kind category, 1.3/1.4 decides the UX (block, or prompt to
  flip) — the data is never ambiguous meanwhile.
- Summary SQL (1.4): signed expression is
  `CASE WHEN kind = 'income' THEN amount_minor ELSE -amount_minor END`.
  Per-category month: `SUM(CASE ...) ... WHERE user_id = :u AND occurred_at
  BETWEEN :a AND :b GROUP BY category_id` — rides the `(user_id,
  occurred_at)` index. Income vs expense: `SUM(...) FILTER (WHERE kind =
  'income')`. Marginally wordier than (a); trivially wrapped once in 1.4.
- CHECKs available: `amount_minor >= 0`, `kind IN (...)` — the DB rejects
  every malformed sign state. Nothing is inexpressible.

### Option (c) — magnitude + kind derived from category, uncategorized defaults to expense

Calling it what it is: a **buried default**. An uncategorized transaction's
kind exists only as an implicit rule in aggregate SQL; re-categorizing an
expense row into an income category silently flips the historical meaning of
the amount; no CHECK can state the invariant because the invariant lives in a
join. Rejected outright.

### Verdict: **(b) — magnitude + NOT NULL `kind` on transactions.**

The denormalization cost (kind appears on both categories and transactions) is
the price of making uncategorized rows, category-loss (`SET NULL`), and
refunds all first-class, while keeping the DB value identical to what
`parseMoney` produces and `toInputString` consumes. Category `kind` remains
the *default/prefill source*; transaction `kind` is the *source of truth for
aggregation*.

**Forces on 1.3/1.4**: transaction create/update schemas carry a required
`kind` (client defaults it from the selected category); category responses
carry `kind` for prefill; 1.4's summary uses the CASE expression above; 1.4
owns the cross-kind re-categorization UX decision and must test "kind survives
category change". Future transfers (stage 5) become a third `kind` value — a
one-line CHECK alter under §3's representation, no data rewrite.

---

## 2. Profiles creation strategy

Options: (i) auto-create in `UserManager.on_after_register`; (ii) lazy
get-or-create on first read; (iii) backfill-only. The backfill migration for
existing users is **mandatory regardless** (1.1 grooming-review §7 carry-forward,
verbatim: "extend `on_after_register` to create the profile row; BACKFILL
profiles for pre-existing users in the 1.2 migration").

**Verdict: (i) hook auto-create going forward + (iii) backfill migration for
the past.** Lazy-create is rejected as the primary mechanism: it puts a write
on read paths and there is no profile read endpoint until later — the row
would materialize at an unpredictable moment.

Mechanics, verified against auth.py: `UserManager.__init__` already captures
the adapter's `AsyncSession` as `self._session` (used by
`_revoke_all_refresh_tokens`, which executes + commits on it). The profile
insert uses the same captured session:
`on_after_register` → `session.add(Profile(user_id=user.id,
base_currency=DEFAULT_BASE_CURRENCY))` → commit. The existing hook is already
a log-only stub with the 1.2 comment in place ("1.2 extends this to create the
profile row").

**Failure mode, stated**: `on_after_register` runs *after* the user row is
committed by the adapter (1.1 spike finding: adapter commits per operation).
If the profile insert fails mid-register, the client gets a 500 while the user
row exists — a retry register then hits "already exists" with no profile.
Accepted for now (single-row insert on a healthy session; the realistic
failure is DB-down, which fails the whole request anyway). **Mitigation
recorded, not built** (Phase 3.6 — no machinery on a guess): the first task
that *reads* profiles (base-currency default at 1.4, or a profile endpoint)
should do get-or-create (`INSERT ... ON CONFLICT (user_id) DO NOTHING`) as a
self-healing read. Until then an orphaned user is repairable by re-running the
backfill statement manually.

**Backfilled `base_currency`**: no client exists, nobody has chosen one.
ASSUMPTION: product language is Russian (architecture doc, seed names) →
default **`RUB`**, as a Python constant `DEFAULT_BASE_CURRENCY = "RUB"` next
to the model (single definition used by both the hook and — as a literal —
the backfill migration). Deliberately NOT a `Settings` knob (speculative
flexibility) and NOT a column `server_default` (a buried DB default would let
future insert sites silently omit an explicit choice; every creation site
names the currency). PM veto point in Open Questions.

**Columns/constraints**:

- `user_id` — PK and FK in one (`Uuid`, FK `users.id`, `ondelete=CASCADE`).
- `base_currency` — `String(3)` NOT NULL, CHECK `base_currency ~ '^[A-Z]{3}$'`
  (named `ck_profiles_base_currency_format` via the `ck_%(table_name)s_%(constraint_name)s`
  convention) — mirrors shared `CURRENCY_CODE_PATTERN` exactly. Shape-check
  only, matching the shared philosophy (unknown-but-well-formed codes are
  legal there; verified in currencies.ts).
- `monthly_income_minor` — `BigInteger` NULL, CHECK
  `monthly_income_minor >= 0` (`ck_profiles_monthly_income_minor_non_negative`;
  NULL passes CHECKs in PG, no special-casing needed). Magnitude convention
  consistent with §1.

No `created_at` and no extra columns — the architecture doc's row is exactly
`user_id, base_currency, monthly_income_minor`; profiles is a settings
extension of `users`, which already has `created_at`.

---

## 3. `categories.kind` representation: native PG ENUM vs varchar + CHECK

**Verdict: `String(16)` + CHECK `kind IN ('expense','income')`, on BOTH
`categories` and `transactions` (same representation, same value set).**

- Native `ENUM` ergonomics under Alembic are genuinely bad: autogenerate does
  not manage type lifecycle (create-before-use on upgrade, orphaned type on
  downgrade), `ALTER TYPE ... ADD VALUE` has transactional restrictions, and
  removing a value is effectively impossible. Adding `'transfer'` later under
  varchar+CHECK is drop-constraint/re-create-constraint — one reversible
  statement with a convention-generated name.
- The naming convention gives us stable, greppable CHECK names
  (`ck_categories_kind_valid`, `ck_transactions_kind_valid`); a PG enum type
  is named outside that convention entirely.
- Wire contract is **identical either way**: 1.3 defines one Python
  `StrEnum` (`expense` / `income`) used by both SQLAlchemy models
  (`String` column, values validated by CHECK) and Pydantic schemas → OpenAPI
  emits a string enum → generated TS union `'expense' | 'income'`. The DB
  representation is invisible to clients, so we pick the operationally
  cheaper one.
- Note for the empty-autogenerate gate: Alembic autogenerate does not compare
  CHECK constraints by default, so CHECKs declared in models and created in
  the migration cannot produce drift noise — but they MUST still be declared
  on the models so metadata is truthful.

---

## 4. System seed set — exact list and shipping mechanism

### Seed list (proposed; PM may edit names/emojis freely — zero migration-design impact)

Russian names per product language. `icon` = emoji string (client-agnostic,
renders on web and native without an icon-font contract — ASSUMPTION, veto
cheap while only seeds use it). `color` = `#RRGGBB` hex.

Expense (13):

| name | icon | color |
|---|---|---|
| Продукты | 🛒 | #4CAF50 |
| Кафе и рестораны | 🍽️ | #FF9800 |
| Транспорт | 🚗 | #2196F3 |
| Жильё | 🏠 | #795548 |
| Здоровье | 💊 | #F44336 |
| Одежда | 👕 | #9C27B0 |
| Развлечения | 🎬 | #E91E63 |
| Связь и интернет | 📱 | #00BCD4 |
| Подписки | 🔁 | #673AB7 |
| Подарки | 🎁 | #FFC107 |
| Путешествия | ✈️ | #3F51B5 |
| Образование | 📚 | #009688 |
| Прочее | 📦 | #9E9E9E |

Income (5):

| name | icon | color |
|---|---|---|
| Зарплата | 💼 | #4CAF50 |
| Фриланс | 🧑‍💻 | #8BC34A |
| Подарки | 🎁 | #CDDC39 |
| Проценты и кэшбэк | 🏦 | #00BCD4 |
| Прочее | 📦 | #9E9E9E |

Duplicate names across kinds ("Подарки", "Прочее") are intentional and legal —
no unique constraint on name (§ below).

### How it ships: **data migration in the chain (0003)**

- **Data migration** (chosen): versioned, runs exactly once per database,
  automatically present in test DBs (verified: conftest `_migrated_schema`
  runs `alembic upgrade head` per session — seeds exist in every test run),
  present in prod on deploy, has a defined downgrade.
- Startup idempotent seed (rejected): runs every boot, needs `ON CONFLICT`
  forever, races across future workers, invisible in migration history, and
  couples app boot to data state.
- Test fixture (rejected): absent in production — the one place the seed is
  actually for.

**Stable UUIDs**: the 18 category ids are hardcoded literal UUID constants in
the 0003 migration file (generated once at authoring time). This makes every
environment (dev/test/prod, and any rebuilt DB) agree on system-category ids —
which matters the moment ids leak into client caches, receipts prompts (2.2
sends the category list to Claude), or `merchant_category_map` (2.5). The
migration file is the single source of truth; application code never
references seed ids — it queries `WHERE user_id IS NULL`. No constants module
that could drift.

**Downgrade of the seed**: `DELETE FROM categories WHERE id IN (<the 18
literals>)` — precise, and safe against user rows. With
`transactions.category_id ON DELETE SET NULL` (§6) the delete cannot be
blocked by referencing transactions.

**Empty-autogenerate stays green — why**: autogenerate diffs
`Base.metadata` against the *schema* (tables, columns, indexes, FKs) via
inspector reflection; it never inspects **rows**. Seeded data is invisible to
it. (Same reason the profiles backfill in §9 is invisible.)

---

## 5. `receipt_id`: now vs 2.1

Options: (a) nullable column now, no FK (receipts table doesn't exist);
(b) omit entirely until 2.1; (c) column now + FK added in 2.1 ("deferred FK").

**Verdict: (b) omit until 2.1.** The architecture sketch includes
`receipt_id`, but the sketch assumes the `receipts` table exists — deviating
here is deliberate and recorded:

- Adding a nullable column + FK in PG later is a metadata-only `ADD COLUMN`
  plus one FK — a trivial, non-locking 2.1 migration on a personal-scale table.
- An FK-less column now is an unconstrained UUID slot: orphan values possible
  from day one, zero enforcement, and it would sit dead in the schema for an
  entire stage. Option (c) is (a) with extra steps — the 2.1 migration happens
  anyway.
- Keeps the 1.4 transaction OpenAPI schema free of a dead field (contract
  churn avoided, not deferred).

**Trigger**: task 2.1 adds `receipt_id Uuid NULL` + FK → `receipts.id`,
`ondelete=SET NULL` (transaction outlives its receipt image), in the same
migration that creates `receipts`.

---

## 6. FK `ondelete` — explicit verdict per relationship

Precedent (verified, 0001): `refresh_tokens.user_id` → CASCADE.

| FK | Verdict | Reasoning |
|---|---|---|
| `profiles.user_id` → `users.id` | **CASCADE** | The profile *is* an extension of the user row; an orphan profile is meaningless. |
| `categories.user_id` → `users.id` (nullable) | **CASCADE** | Deleting a user removes their custom categories. System rows (`user_id IS NULL`) don't participate in the FK — unaffected by any user delete. |
| `transactions.user_id` → `users.id` | **CASCADE** | Personal app: user deletion wipes the user's data, consistent with refresh_tokens. (No user-delete endpoint exists today — `/users/{id}` DELETE is superuser-gated — but the DB must still have an answer.) |
| `transactions.category_id` → `categories.id` | **SET NULL** | The product rule is archive-not-delete, but DELETE must be defined. CASCADE would silently destroy transaction history — wrong. RESTRICT would block the user-CASCADE path above. SET NULL degrades a transaction to "uncategorized", which is a fully legal state precisely because `kind` lives on the transaction (§1) — the two decisions reinforce each other. During a user delete both cascade paths fire (tx rows CASCADE-deleted via user_id; SET NULL via their categories is a harmless no-op race PG resolves within the statement). |

**Cross-user category reference — position**: the DB does NOT enforce that a
transaction's category is "system or owned by the same user". A plain FK
cannot express "categories.user_id IS NULL OR = transactions.user_id" (the
composite-FK trick fails on the NULL/system case), and a trigger is machinery
this app doesn't warrant. This is an **authorization invariant owned by
1.3/1.4 write paths** (on create/update: load the category, require
`category.user_id IS NULL OR category.user_id == current_user.id`) and it MUST
be pytest-covered there. Recorded as a binding forcing on 1.4.

**System-category protection — position**: also API-level, at 1.3: any
mutation (rename/icon/color/archive) must reject rows with
`user_id IS NULL` — `archived` is a global column, so archiving a system
category would archive it for everyone; per-user hiding of system categories
would need a join table and is out of scope (trigger: if the product ever
wants it). No category DELETE endpoint exists at all in 1.3.

**No unique constraint on `categories (user_id, name)`**: duplicate names
across kinds are in the seed itself; case-folding plus the archived state make
a correct partial unique index disproportionate. Softness (warn/validate)
belongs to 1.3 if desired.

---

## 7. Index verdicts

| Candidate | Verdict | Reasoning |
|---|---|---|
| `transactions (user_id, occurred_at)` composite | **YES** — explicit name `ix_transactions_user_id_occurred_at` | The workhorse for every 1.4 list/filter/summary and every 4.1 aggregate (architecture doc: "SQL-агрегаты … по индексу (user_id, occurred_at)"). Explicit name required: the `ix_%(column_0_label)s` convention would generate a first-column-only name; explicit names follow the same readable pattern (0001 precedent: all names explicit via `op.f`). |
| separate `transactions.user_id` | **NO** | Redundant: the composite's leading column serves every `user_id =` predicate. The architecture sketch's `index=True` on user_id *plus* the composite would create a strictly dominated index on the highest-write table. Recorded deviation from the sketch. |
| `transactions.category_id` | **NO for now** | 1.4's category filter always leads with `user_id` + a date range — the composite fetches the window and the filter is applied in-memory over personal-scale row counts (thousands). FK reverse lookup (SET NULL on category delete) only fires on the rare/never delete path. Trigger to revisit: 2.5 (`merchant_category_map` confirmation queries) or 4.1 if EXPLAIN shows it. |
| `categories.user_id` | **YES** — `ix_categories_user_id` | Matches the 0001 precedent of indexing FK columns that have a real query (`WHERE user_id = :u OR user_id IS NULL` on every category list, plus the user-CASCADE path). Tiny table, negligible cost. |
| `profiles` | **PK only** | `user_id` is the PK; the only access path. |
| `transactions.occurred_at` alone | **NO** | No query filters by date without user scope (security §3: every query is user-filtered); second column of the composite covers it in context. |

---

## 8. Thin repository/domain layer now vs endpoints-first

**Verdict: NO new layer in this task.** Ships: three model modules,
`models/__init__.py` re-exports (env.py imports the package — verified),
migrations, tests. Zero code in `domain/`, `services/`, `repositories/`
(which doesn't exist and is not created).

- The established layering (verified in routers/auth.py, routers/users.py) is
  routers → sessions/adapters directly; `domain/` is reserved for pure logic
  (its first real tenant is `domain/goals.py` at 3.3, per the architecture
  doc). There is exactly one prospective consumer per query today — a
  repository interface now is premature abstraction with no second
  implementation and no caller.
- Phase 3.6 intent gate: erecting query machinery before 1.3/1.4 exist means
  guessing their access patterns; wrong guesses become load-bearing.
- Extraction rule recorded for 1.3/1.4: the first query needed by BOTH tasks
  (likely "visible categories for user X" = `user_id = :u OR user_id IS
  NULL`) gets extracted by the *second* consumer, not pre-built by the zeroth.

The one piece of near-production code this task does touch is the
`on_after_register` profile insert (§2) — that lives in the existing
`UserManager`, not a new layer.

---

## 9. Migration topology

**Verdict: split — 0002 schema (pure DDL), 0003 data (seed + backfill),
chained 0001 ← 0002 ← 0003.**

- 0002 stays autogenerate-comparable and hand-reviewable as pure DDL with a
  fully symmetric downgrade (drop indexes, drop tables — mirroring 0001's
  style, verified). Mixing data statements into it would make its
  downgrade semantics mixed-mode.
- 0003 (data) depends on 0002's tables. Contents:
  1. Seed: `op.bulk_insert`/`INSERT` of the 18 system categories with
     hardcoded UUIDs (§4). Explicit values for `archived=false`.
  2. Backfill: `INSERT INTO profiles (user_id, base_currency)
     SELECT id, 'RUB' FROM users ON CONFLICT (user_id) DO NOTHING` —
     idempotent by construction, satisfies the binding 1.1 carry-forward.
- **0003 downgrade semantics (recorded consciously)**: deletes the 18 seed
  rows by id; does **NOT** delete profiles. Backfilled profiles are
  indistinguishable from hook-created ones post-hoc, and on a full downgrade
  0002's `drop_table("profiles")` removes them anyway. This asymmetry is
  deliberate and documented in the migration docstring.
- **Defaults style, consistent with 0001/models (verified)**: `id` — Python
  default `uuid.uuid4` (as `users.id`), no server default; `created_at` —
  `DateTime(timezone=True), server_default=func.now()` (as `users.created_at`);
  `archived` — `default=False, server_default=false()` (the `is_active`
  pattern). Migration DDL carries the server defaults (`sa.text("now()")`,
  `sa.text("false")`) exactly as 0001 does, so models and migration agree and
  the empty-autogenerate probe stays green.

### Test-infrastructure landmine (flag for backend-engineer, verified in conftest.py)

The per-test cleanup is `TRUNCATE users, refresh_tokens RESTART IDENTITY
CASCADE`. `TRUNCATE ... CASCADE` is **table-level**: it truncates every table
with an FK referencing the listed ones — after 0002 that includes `profiles`,
`transactions`, AND **all of `categories`, wiping the 18 seed rows** on the
first test. The cleanup must change to row-level deletion, e.g.
`DELETE FROM users` (per-row `ondelete` CASCADE clears profiles, user
categories, transactions, refresh_tokens; system categories with
`user_id IS NULL` survive). How exactly is implementation latitude — the
architectural requirement is: **per-test cleanup must preserve seeded system
categories**, and a test should pin that they exist.

---

## Resulting schema (summary)

### Tables

- `profiles`
  - `user_id` (Uuid, PK, FK → users.id CASCADE)
  - `base_currency` (String(3), NOT NULL, CK `~ '^[A-Z]{3}$'`)
  - `monthly_income_minor` (BigInteger, NULL, CK `>= 0`)
- `categories`
  - `id` (Uuid, PK, default uuid4)
  - `user_id` (Uuid, NULL = system, FK → users.id CASCADE)
  - `name` (String(100), NOT NULL)
  - `icon` (String(16), NULL) — emoji string
  - `color` (String(7), NULL) — `#RRGGBB`; format validated at 1.3 API level, no CHECK (cheap to leave latitude for future formats)
  - `kind` (String(16), NOT NULL, CK `IN ('expense','income')`)
  - `archived` (Boolean, NOT NULL, default/server_default false)
  - Indexes: `ix_categories_user_id`
- `transactions`
  - `id` (Uuid, PK, default uuid4)
  - `user_id` (Uuid, NOT NULL, FK → users.id CASCADE)
  - `amount_minor` (BigInteger, NOT NULL, CK `>= 0`) — magnitude; zero allowed at DB level, 1.4 decides API policy
  - `kind` (String(16), NOT NULL, CK `IN ('expense','income')`) — §1 verdict
  - `currency` (String(3), NOT NULL, CK `~ '^[A-Z]{3}$'`)
  - `category_id` (Uuid, NULL, FK → categories.id SET NULL)
  - `occurred_at` (Date, NOT NULL)
  - `note` (Text, NULL) — length cap is a 1.4 API decision, not a DB constraint
  - `created_at` (DateTime(timezone=True), NOT NULL, server_default now())
  - Indexes: `ix_transactions_user_id_occurred_at` (user_id, occurred_at)
  - NO `receipt_id` (§5)

Model style: plain `Mapped[...]`/`mapped_column` WITHOUT the
`TYPE_CHECKING` split — that split exists solely to satisfy fastapi-users
protocols (verified docstrings in user.py/refresh_token.py); these models
serve no library protocol.

### Migration steps

1. `0002_core_tables` (revises 0001): create `profiles`, `categories`,
   `transactions` + the two named indexes + all named CKs/FKs. Downgrade:
   symmetric drops (transactions → categories → profiles).
2. `0003_seed_and_backfill` (revises 0002): insert 18 system categories
   (hardcoded UUIDs); backfill profiles for existing users
   (`ON CONFLICT DO NOTHING`, base_currency `'RUB'`). Downgrade: delete seed
   rows by id; profiles left in place (documented).
3. Code: `Profile`, `Category`, `Transaction` models; `models/__init__.py`
   re-exports; `on_after_register` profile insert; conftest cleanup rework
   (§9 landmine); `DEFAULT_BASE_CURRENCY = "RUB"` constant.
4. Non-architectural carry-forward (b), delegated to backend-engineer per
   root-file ownership: `env: ["TEST_DATABASE_URL"]` on `@budget/api#test` in
   turbo.json — one line, decided here, no architectural content.

## Module structure

New files: `models/profile.py`, `models/category.py`, `models/transaction.py`
(one model per module, matching user.py/refresh_token.py). Touched:
`models/__init__.py`, `auth.py` (hook body only), `tests/conftest.py`,
`alembic/versions/` (+2 files), `turbo.json` (carry-forward (b)). NOT touched:
`schemas/`, `routers/`, `domain/`, `services/`, `openapi.json`,
`packages/api-client`.

Dependency direction unchanged: models depend only on `models/base`; `auth.py`
already imports models (existing edge); no new edges. routes → (services) →
sessions → models holds.

## Trade-offs considered (index)

- Signed amount vs magnitude+kind vs derived kind: §1 — chose (b).
- Hook vs lazy vs backfill-only profiles: §2 — hook + backfill.
- PG ENUM vs varchar+CHECK: §3 — varchar+CHECK.
- Data migration vs startup seed vs fixture: §4 — data migration.
- receipt_id now vs 2.1: §5 — omit.
- Per-FK ondelete: §6 table.
- Per-index verdicts: §7 table.
- Repository layer now vs later: §8 — later (extraction rule recorded).
- One migration vs split: §9 — split.

## What this does NOT decide (left to backend-engineer / later tasks)

- Exact SQLAlchemy declaration details (CheckConstraint spelling,
  `__table_args__` ordering), autogenerate-then-hand-edit workflow.
- Exact conftest cleanup mechanics (requirement fixed in §9; mechanism free).
- Test list specifics (model round-trips, constraint violations, migration
  up/down cycle, seed-survives-cleanup) — pytest-conventions apply.
- 1.3: StrEnum location, category schemas, system-category mutation guards.
- 1.4: summary SQL wrapper, zero-amount API policy, note length cap,
  cross-kind re-categorization UX, cross-user category authorization test.
- 2.1: `receipt_id` column + FK. 2.5/4.1: category_id index revisit.

## Assumptions (each flagged inline, collected)

1. Default base currency `RUB` (product language; personal app) — §2.
2. `icon` is an emoji string, not an icon-font key — §4.
3. Seed list contents (names/colors) are a proposal, freely editable — §4.
4. Refunds are representable as income-kind transactions against expense
   categories (no tx.kind==category.kind constraint) — §1/§6.
5. No user-facing user-deletion flow exists; CASCADE verdicts are DB-hygiene,
   not endpoint design — §6.

## Open questions for PM (veto-style; defaults = recommendations)

1. **Backfill/default base currency: `RUB` or `USD`?** Recommend **RUB**
   (Russian-language product, personal use). One-line change either way.
2. **Transaction `kind` independent of category kind (refunds expressible) vs
   hard rule tx.kind must match category.kind?** Recommend **independent, no
   DB constraint** — enables refunds and survives SET NULL; 1.4 owns the UX.
3. **Seed set: ship the proposed 13+5 list vs trim to a minimal 8 (Продукты,
   Кафе, Транспорт, Жильё, Здоровье, Прочее / Зарплата, Прочее)?** Recommend
   **the full proposed list** — deleting unused system categories later is
   harder (transactions may reference them) than never wanting more.
4. **`receipt_id` omitted until 2.1 (deviation from the architecture sketch)
   vs nullable FK-less column now?** Recommend **omit** — nullable ADD COLUMN
   at 2.1 is free; an unconstrained UUID column is not.
5. **Zero-amount transactions: allowed at the DB (`>= 0`) with API policy
   deferred to 1.4, vs DB CHECK `> 0` now?** Recommend **`>= 0` at DB** —
   a zero row is harmless in every aggregate; strictness is contract policy,
   and the contract task is 1.4.

No blocking questions; all defaults are safe to proceed with.
