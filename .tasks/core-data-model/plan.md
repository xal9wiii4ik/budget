# Implementation Plan: core-data-model (roadmap 1.2)

Implements `architecture.md` (ACCEPTED, binding). No structural decision is
re-opened here; every verdict below is the architecture's, spelled to
implementation detail. Deviations from architecture require senior-lead
sign-off — none are taken silently; the two judgment calls I make (test-scope
trims, backfill-test mechanism) are surfaced in **Open questions** for sign-off.

## Approach

Three column-only ORM models (`Profile`, `Category`, `Transaction`) on the
existing naming-convention `Base`, in the plain `Mapped[...]`/`mapped_column`
style of `user.py`/`refresh_token.py` **minus** the `TYPE_CHECKING` split (that
split exists only to satisfy fastapi-users protocols — verified in the model
docstrings; these tables serve no library protocol, architecture §"Model
style"). Schema ships as **two migrations**: `0002` pure DDL (tables + named
indexes + named CHECK/FK, fully symmetric downgrade, mirroring `0001`'s
`op.f`/`sa.text` style) and `0003` data (18 hardcoded-UUID system categories +
profiles backfill for pre-existing users). The `on_after_register` hook is
extended to create a `RUB` profile going forward; the backfill covers the past
(binding carry-forward (a)). `conftest.py`'s per-test `TRUNCATE … CASCADE` is
replaced with row-level `DELETE FROM users` so the 18 seed rows survive
isolation (the §9 landmine). `turbo.json` gains one line (carry-forward (b)).

Why this shape over alternatives is entirely settled in architecture.md
(§1 magnitude+`kind`, §2 hook+backfill+`RUB`, §3 varchar+CHECK, §4 data
migration + stable UUIDs, §5 no `receipt_id`, §6 ondelete table, §7 indexes,
§8 no new layer, §9 split + landmine). The single load-bearing runtime edge is
the hook write on `self._session` — already the proven pattern for
`_revoke_all_refresh_tokens` (verified auth.py:55/101-108).

Key trade-off accepted: `kind` is denormalized onto `transactions` (also on
`categories`), which is the price of making uncategorized rows, `SET NULL`
category loss, and refunds all first-class while keeping the stored value
identical to what shared `parseMoney` produces (architecture §1 verdict (b)).

## New files

- `apps/api/src/budget_api/models/profile.py` — `Profile` model +
  `DEFAULT_BASE_CURRENCY = "RUB"` constant (single definition; imported by the
  hook, duplicated as a literal in the 0003 migration per frozen-migration
  convention).
- `apps/api/src/budget_api/models/category.py` — `Category` model.
- `apps/api/src/budget_api/models/transaction.py` — `Transaction` model.
- `apps/api/alembic/versions/0002_core_tables.py` — DDL for the three tables.
- `apps/api/alembic/versions/0003_seed_and_backfill.py` — seed + backfill data.
- `apps/api/tests/test_core_model.py` — constraint/FK/seed/hook pytest.
- `apps/api/tests/test_migrations.py` — backfill (pre-existing user) pytest.

## Files to modify

- `apps/api/src/budget_api/models/__init__.py` — re-export `Profile`,
  `Category`, `Transaction` so `alembic/env.py` (imports the package) registers
  them on `Base.metadata`. Update `__all__`.
- `apps/api/src/budget_api/auth.py` — extend `on_after_register` to insert the
  profile on `self._session` + commit; import `Profile` and
  `DEFAULT_BASE_CURRENCY`.
- `apps/api/tests/conftest.py` — `_clean_tables`: `TRUNCATE … CASCADE` →
  `DELETE FROM users` (§9 landmine).
- `turbo.json` — add `"env": ["TEST_DATABASE_URL"]` to `@budget/api#test`
  (carry-forward (b); root-file ownership = backend-engineer, (c)).

**NOT touched** (architecture "Module structure"): `schemas/`, `routers/`,
`domain/`, `services/`, `openapi.json`, `packages/api-client`. The OpenAPI
contract does **not** change in this task (architecture §Context); carry-forward
(e) is not triggered — nothing regenerates.

## Code skeletons

### `models/profile.py`

```python
"""Profile model — per-user settings extension of the user row (architecture §2)."""
import uuid
from sqlalchemy import BigInteger, CheckConstraint, ForeignKey, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column
from budget_api.models.base import Base

# Single definition: the register hook uses this; the 0003 backfill duplicates
# it as a literal 'RUB' (migrations are frozen snapshots, must not import app code).
DEFAULT_BASE_CURRENCY = "RUB"


class Profile(Base):
    __tablename__ = "profiles"
    __table_args__ = (
        CheckConstraint("base_currency ~ '^[A-Z]{3}$'", name="base_currency_format"),
        CheckConstraint(
            "monthly_income_minor >= 0", name="monthly_income_minor_non_negative"
        ),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    base_currency: Mapped[str] = mapped_column(String(3))          # NOT NULL via Mapped[str]
    monthly_income_minor: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
```

Names produced (verified against `base.py` `NAMING_CONVENTION`):
`pk_profiles`, `fk_profiles_users_user_id`, `ck_profiles_base_currency_format`,
`ck_profiles_monthly_income_minor_non_negative`. (Convention `ck` =
`ck_%(table_name)s_%(constraint_name)s`, so the `name=` passed to
`CheckConstraint` is the suffix only.)

### `models/category.py`

```python
"""Category model — system (user_id IS NULL) or user-owned (architecture §3/§6)."""
import uuid
from sqlalchemy import Boolean, CheckConstraint, ForeignKey, String, Uuid, false
from sqlalchemy.orm import Mapped, mapped_column
from budget_api.models.base import Base


class Category(Base):
    __tablename__ = "categories"
    __table_args__ = (
        CheckConstraint("kind IN ('expense', 'income')", name="kind_valid"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True
    )
    name: Mapped[str] = mapped_column(String(100))
    icon: Mapped[str | None] = mapped_column(String(16), nullable=True)   # emoji string
    color: Mapped[str | None] = mapped_column(String(7), nullable=True)   # #RRGGBB, no DB CHECK
    kind: Mapped[str] = mapped_column(String(16))
    archived: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())
```

Names: `pk_categories`, `fk_categories_users_user_id`,
`ck_categories_kind_valid`, `ix_categories_user_id` (from `index=True` →
`ix_%(column_0_label)s`). `archived` uses the `is_active` pattern
(`default=False, server_default=false()`, verified user.py).

### `models/transaction.py`

```python
"""Transaction model — magnitude + NOT NULL kind (architecture §1 verdict (b))."""
import uuid
from datetime import date, datetime
from sqlalchemy import (
    BigInteger, CheckConstraint, Date, DateTime, ForeignKey, Index,
    String, Text, Uuid, func,
)
from sqlalchemy.orm import Mapped, mapped_column
from budget_api.models.base import Base


class Transaction(Base):
    __tablename__ = "transactions"
    __table_args__ = (
        CheckConstraint("amount_minor >= 0", name="amount_minor_non_negative"),
        CheckConstraint("kind IN ('expense', 'income')", name="kind_valid"),
        CheckConstraint("currency ~ '^[A-Z]{3}$'", name="currency_format"),
        Index("ix_transactions_user_id_occurred_at", "user_id", "occurred_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE")   # NO index=True — §7 (composite covers it)
    )
    amount_minor: Mapped[int] = mapped_column(BigInteger)   # magnitude; zero allowed at DB
    kind: Mapped[str] = mapped_column(String(16))
    currency: Mapped[str] = mapped_column(String(3))
    category_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("categories.id", ondelete="SET NULL"), nullable=True
    )
    occurred_at: Mapped[date] = mapped_column(Date)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)   # no DB length cap (1.4 API)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
```

Names: `pk_transactions`, `fk_transactions_users_user_id`,
`fk_transactions_categories_category_id` (distinct — convention keys on
`referred_table_name` + `column_0_name`), `ck_transactions_amount_minor_non_negative`,
`ck_transactions_kind_valid`, `ck_transactions_currency_format`,
`ix_transactions_user_id_occurred_at` (explicit — §7 forbids the
first-column-only auto name). No ORM `relationship()` on any model: cascade is
DB-level (`ondelete`), matching `refresh_token.py`; no task here needs eager
navigation.

### `models/__init__.py`

Add the three imports; `__all__` becomes
`["Base", "Category", "Profile", "RefreshToken", "Transaction", "User"]`.
`DEFAULT_BASE_CURRENCY` stays importable from `budget_api.models.profile`
(architecture §2: "next to the model").

### `auth.py` — `on_after_register`

```python
async def on_after_register(self, user: User, request: Request | None = None) -> None:
    # 1.2: provision the user's profile row (architecture §2). Same captured
    # session the token-revocation path uses (self._session, verified :55/:101).
    self._session.add(Profile(user_id=user.id, base_currency=DEFAULT_BASE_CURRENCY))
    await self._session.commit()
    logger.info("user registered: %s", user.id)
```

- Imports: `from budget_api.models import Profile` and
  `from budget_api.models.profile import DEFAULT_BASE_CURRENCY`.
- Interaction with existing body: the log line is **kept**, moved after the
  commit so it reflects a fully-provisioned user. No other hook changes.
- Error path (architecture §2, accepted, not built): the adapter already
  committed the `users` row before this hook runs (1.1 finding). If this commit
  fails the client gets 500 with a user row but no profile; the realistic cause
  is DB-down (whole request fails anyway). Self-healing get-or-create is a
  recorded 1.4 mitigation, **not** implemented here.

## Migrations

### 0002 — authoring workflow (pure DDL)

**Workflow: autogenerate-to-scaffold, then hand-edit to 0001 style, then
re-probe.**
1. With models in place and DB at `0001`, run
   `uv run alembic revision --autogenerate -m "core tables"` to capture the
   correct column list/types.
2. Hand-edit the generated file to match `0001` exactly: wrap every constraint/
   index name in `op.f(...)`, order columns as declared, add the CHECK
   constraints (autogenerate omits them — see below), write a **symmetric**
   `downgrade()` dropping in reverse-dependency order
   (`transactions` → `categories` → `profiles`, indexes before tables),
   `revision="0002"`, `down_revision="0001"`. Server defaults as `sa.text(...)`
   (`sa.text("false")` for `archived`, `sa.text("now()")` for `created_at`),
   mirroring 0001.
3. Re-run the autogenerate probe against a DB at `0002` and confirm the
   generated `upgrade()`/`downgrade()` bodies are empty (`pass` only), then
   delete the throwaway file.

**What the probe actually compares (so the green check is meaningful):** Alembic
autogenerate diffs `Base.metadata` against inspector reflection of the live
schema — **tables, columns (name + nullability), indexes, unique constraints,
FK presence, PK**. By default it does **not** compare column *types*
(`compare_type=False`), server defaults (`compare_server_default=False`), CHECK
constraints, or **rows**. So: (a) the CHECK constraints declared on the models
cannot create probe drift — but they MUST still be declared so
`Base.metadata` is truthful (architecture §3 note); (b) the 0003 seed rows and
profiles backfill are invisible to the probe (rows aren't reflected). A green
probe therefore certifies the *structural* skeleton (tables/columns/indexes/FKs)
matches the models — which is exactly the guarantee we want, with CHECK
correctness covered by the pytest constraint tests instead.

Column/constraint inventory in 0002 exactly follows the model skeletons and the
architecture "Resulting schema" table.

### 0003 — seed + backfill (data)

`revision="0003"`, `down_revision="0002"`.

**Seed:** `op.bulk_insert` of 18 system categories with **hardcoded UUID
literals generated at plan time** (below — locked so dev/test/prod/rebuilt DBs
agree, architecture §4). `user_id=None`, `archived=False` explicit on every row.

Locked seed UUIDs (name / kind / icon / color from architecture §4; PM may edit
names/emojis/colors — zero migration-design impact; ids are frozen):

| id | name | kind | icon | color |
|---|---|---|---|---|
| `ce814749-2554-40be-8952-3a63d505694f` | Продукты | expense | 🛒 | #4CAF50 |
| `f9a5b100-13a0-49c4-9da1-f23a07f70e81` | Кафе и рестораны | expense | 🍽️ | #FF9800 |
| `fbee0e67-0fd3-49b2-851d-fff8bc390255` | Транспорт | expense | 🚗 | #2196F3 |
| `c861af3a-73f2-475e-af4f-0556d7d143c9` | Жильё | expense | 🏠 | #795548 |
| `6c53a9ed-9fb0-4cf5-aba2-1c36e1296d23` | Здоровье | expense | 💊 | #F44336 |
| `1ac8d199-db1d-487c-9080-6949a62aad66` | Одежда | expense | 👕 | #9C27B0 |
| `1b0f9d5f-df44-471b-b084-b9db75d42d50` | Развлечения | expense | 🎬 | #E91E63 |
| `2363f62a-b11c-42cc-8121-49286fb4f098` | Связь и интернет | expense | 📱 | #00BCD4 |
| `ebcb3fe0-e47b-4327-8248-b3d19e89c2c9` | Подписки | expense | 🔁 | #673AB7 |
| `0f69fdb2-ff62-4fd9-b59b-ad891d992035` | Подарки | expense | 🎁 | #FFC107 |
| `a786fbc9-d36e-458a-842b-6d4d9ed29c58` | Путешествия | expense | ✈️ | #3F51B5 |
| `f80ae2b9-38ea-4d08-a169-58b203e9ea10` | Образование | expense | 📚 | #009688 |
| `3363eedd-dde8-45e7-853b-f9fcef853229` | Прочее | expense | 📦 | #9E9E9E |
| `8fe4d517-33d6-437d-a2c0-4cd95e262676` | Зарплата | income | 💼 | #4CAF50 |
| `00d81258-6d7e-4b83-ab44-f8ff62fddb7f` | Фриланс | income | 🧑‍💻 | #8BC34A |
| `f9c4adfa-2db5-4d6f-bdf8-d5c55c7de457` | Подарки | income | 🎁 | #CDDC39 |
| `bd83bb2c-8561-4f06-8a8c-61a2b40fe6bb` | Проценты и кэшбэк | income | 🏦 | #00BCD4 |
| `fd316f6c-fa04-456b-a0c2-46e781568d56` | Прочее | income | 📦 | #9E9E9E |

Duplicate names across kinds ("Подарки", "Прочее") are intentional and legal
(no unique constraint — architecture §6).

**Backfill:**
```python
op.execute(
    "INSERT INTO profiles (user_id, base_currency) "
    "SELECT id, 'RUB' FROM users ON CONFLICT (user_id) DO NOTHING"
)
```
Idempotent by construction; satisfies carry-forward (a).

**Downgrade (asymmetric — documented in the migration docstring):** `DELETE
FROM categories WHERE id IN (<the 18 literals>)` only. Profiles are **not**
deleted — backfilled profiles are indistinguishable from hook-created ones
post-hoc, and a full `downgrade base` drops the `profiles` table via 0002
anyway (architecture §9). `SET NULL` on `transactions.category_id` means the
seed delete cannot be blocked by referencing transactions.

## conftest cleanup rework (§9 landmine)

Replace, in `_clean_tables`:
```python
await conn.execute(text("TRUNCATE users, refresh_tokens RESTART IDENTITY CASCADE"))
```
with:
```python
await conn.execute(text("DELETE FROM users"))
```
Update the docstring to explain the seed-preservation intent.

Why correct given the ondelete graph: `DELETE FROM users` fires **row-level** FK
actions — `profiles`, `categories(user_id=…)`, `transactions`, and
`refresh_tokens` all cascade (all four FKs are `ondelete=CASCADE`). System
categories (`user_id IS NULL`) don't participate in the user FK, so the 18 seed
rows survive. `TRUNCATE … CASCADE` was table-level and would wipe **all** of
`categories` (seed included) via the FK graph — the bug the architecture flagged.
`RESTART IDENTITY` is dropped (no serial/identity columns; all PKs are UUID).
No explicit `CASCADE` keyword needed on `DELETE` — row triggers handle it in one
statement. Isolation properties are preserved: every test still starts with zero
users and zero user-owned rows; the only persistent state is the immutable 18
system categories, which is the point.

## turbo.json (carry-forward (b))

Add one line to `@budget/api#test`:
```json
    "@budget/api#test": {
      "inputs": ["src/**", "tests/**", "pyproject.toml", "uv.lock", "alembic/**", "alembic.ini", "openapi.json"],
      "env": ["TEST_DATABASE_URL"],
      "outputs": []
    },
```
Rationale: the test task reads `TEST_DATABASE_URL` (conftest); declaring it in
`env` keeps turbo's cache key correct across the committed-5433 vs local-5443
split (carry-forward (f)).

## Test plan (pytest)

Real Postgres, subprocess-alembic session schema, per-test `DELETE FROM users`
cleanup — existing conventions. Setup uses the `db_session` fixture (raw
`text()` inserts for users, ORM objects for the new tables since these models
have no `TYPE_CHECKING` split and can be referenced directly). Applying the
project test policy (minimum tests, maximum meaning; no test that re-asserts
another's branch), the list is **8 tests**:

`tests/test_core_model.py`

- `TestConstraints::test_negative_amount_rejected` — insert a valid user +
  transaction, then a second with `amount_minor=-1` → `IntegrityError`
  (`ck_transactions_amount_minor_non_negative`). Pins the magnitude invariant
  (§1). **INCLUDE.**
- `TestConstraints::test_invalid_kind_rejected` — `kind='transfer'` →
  `IntegrityError` (`ck_transactions_kind_valid`). Pins the §1 headline value
  set; genuinely breakable (a wrong `IN (...)` list). **INCLUDE.**
- `TestConstraints::test_bad_currency_format_rejected` — `currency='usd'`
  (lowercase) → `IntegrityError` (`ck_transactions_currency_format`). Pins the
  shared-pattern regex CHECK. **INCLUDE.**
- `TestForeignKeys::test_user_delete_cascades` — user + profile + user-owned
  category + transaction; `DELETE FROM users WHERE id=…`; assert all four rows
  gone. Pins three CASCADE FKs at once (§6). **INCLUDE.**
- `TestForeignKeys::test_category_delete_sets_null_and_kind_survives` — user +
  category(`kind='expense'`) + transaction(that category, `kind='expense'`);
  delete the category; assert the transaction still exists with
  `category_id IS NULL` **and** `kind == 'expense'`. This contrast IS the §1
  design (kind on the transaction survives category loss). Highest-value test in
  the task. **INCLUDE.**
- `TestSystemCategories::test_seed_present_and_stable` — after autouse cleanup:
  `SELECT count(*) FROM categories` == 18, all `user_id IS NULL`, and a stable
  spot-check (`ce814749-…` → name "Продукты", kind "expense"). Because cleanup
  is autouse and ran before this test, a passing count==18 **also proves seeds
  survive per-test cleanup** — no separate survival test. **INCLUDE.**
- `TestProfileCreation::test_register_creates_rub_profile` — register via the
  live endpoint (`/auth/register`), then assert a `profiles` row exists for the
  new user with `base_currency='RUB'`. Pins the hook wiring / carry-forward (a).
  **INCLUDE.**

`tests/test_migrations.py`

- `TestBackfill::test_backfill_creates_profile_for_preexisting_user` —
  simulates a pre-existing (pre-hook) user and drives the real 0003 backfill:
  1. subprocess `alembic downgrade 0002` (seed gone; `profiles` empty);
  2. insert a user directly (raw SQL, no hook, so no profile);
  3. subprocess `alembic upgrade 0003` (backfill fires);
  4. assert the user now has a `base_currency='RUB'` profile and seed count == 18;
  5. `finally:` `alembic upgrade head` + `DELETE FROM users` to restore state.
  Answers architecture's explicit "how to simulate a pre-existing user"
  question by staging the row at revision 0002 and running the actual migration
  (higher fidelity than copying the backfill SQL into the test). **INCLUDE**,
  with the fragility mitigation (try/finally restore) — see Risks. *Alternative
  considered and rejected:* copy the backfill `INSERT … SELECT … ON CONFLICT`
  into the test and run it against an in-test user — robust/isolated but tests a
  copy, not the migration, and cannot catch drift in the migration's own
  statement. Flagged for senior sign-off (Open questions).

**Evaluated and EXCLUDED (each would violate the no-redundant-test policy):**

- *Model round-trips (bare insert-then-read).* Excluded — a pure round-trip is a
  column-existence test (pytest-conventions forbids). Happy-path insertability of
  a full transaction (all columns + `created_at` server default) is already
  exercised by both FK tests, which insert valid rows and read them back.
- *Profiles `monthly_income_minor >= 0` CHECK* and *profiles `base_currency`
  format CHECK.* Excluded — same constraint *classes* as
  `ck_transactions_amount_minor_non_negative` and
  `ck_transactions_currency_format` (identical SQL: `>= 0` and the same regex).
  Testing them re-asserts the same branch (CLAUDE.md: no redundant tests). The
  one residual gap (a typo in one migration CHECK line but not its twin) is
  accepted and flagged in Open questions.
- *Categories `kind_valid` CHECK.* Excluded — identical value-set CHECK to
  `ck_transactions_kind_valid`, tested there.
- *Empty-autogenerate probe as pytest.* Excluded from pytest — it needs a
  throwaway DB at head, a subprocess revision run, and generated-script parsing;
  it's a build/CI/manual gate (1.1 had no pytest for it either). Kept as a
  **verification command** (below).
- *openapi.json byte-identical as a new test.* Excluded — the existing
  `test_openapi_export::test_committed_schema_matches_current_app` already
  asserts `committed == current-app-output`. Since this task touches no
  `schemas/`/`routers/`, the exporter output is unchanged and that test passes;
  had we accidentally altered the contract, it would fail. It is sufficient — no
  new test. (QA additionally confirms `git` shows `openapi.json` unmodified.)

## Existing patterns to reuse

- `models/base.py` `Base` + `NAMING_CONVENTION` — every constraint/index name
  above is derived from it (no manual names except the composite Index, which
  §7 mandates be explicit).
- `user.py`/`refresh_token.py` — `Uuid` PK with `default=uuid.uuid4`, tz-aware
  `created_at` `server_default=func.now()`, `default/server_default=false()`
  boolean pattern, `ForeignKey(..., ondelete="CASCADE")`.
- `auth.py:55/101-108` — `self._session` add/execute + `commit()` pattern reused
  verbatim for the profile insert.
- `alembic/versions/0001_users_and_refresh_tokens.py` — `op.f` naming,
  `sa.text(...)` server defaults, symmetric `downgrade()` ordering.
- `conftest.py` `db_session` / `make_client` / `client` fixtures and
  `test_auth.py` raw-`text()` insert style (expired-token test) for setup.

## Database changes

Fully specified in architecture.md "Resulting schema" and reproduced in the
skeletons above. Three new tables, two named indexes, six named CHECKs, four
FKs; migrations `0002` (DDL) + `0003` (data). No changes to `users`/
`refresh_tokens`.

## Verification

Run from `apps/api/` (note: repo has **no Makefile**; the real commands are
below — the `make test` reference in the brief maps to `uv run pytest` /
`pnpm --filter @budget/api test`). Local Postgres on **5443**, committed default
**5433** (carry-forward (f)):

```bash
# tests (local PG 5443)
TEST_DATABASE_URL=postgresql+asyncpg://budget:budget@localhost:5443/budget_test \
  uv run pytest

# lint + format
uv run ruff check . && uv run ruff format --check .

# type-check (strict on src)
uv run pyright

# migration up/down cycle against a scratch DB (DATABASE_URL, not TEST_)
DATABASE_URL=postgresql+asyncpg://budget:budget@localhost:5443/budget_scratch \
  uv run alembic upgrade head
DATABASE_URL=…/budget_scratch uv run alembic downgrade base
DATABASE_URL=…/budget_scratch uv run alembic upgrade head   # re-up proves reversibility

# empty-autogenerate probe (DB at head) — expect empty upgrade()/downgrade()
DATABASE_URL=…/budget_scratch \
  uv run alembic revision --autogenerate -m "probe"   # inspect: body is `pass`; then delete the file
```

### Per-amendment / carry-forward checklist (Phase 4 obligation, format per
auth `grooming-review.md` §5)

The /implement report MUST tick every row below **individually** (standing rule,
0.1 retro):

| Binding item | Source | Where satisfied |
|---|---|---|
| (a) profiles backfill for pre-existing users | task (a) / auth §7 | 0003 backfill + `test_backfill_creates_profile_for_preexisting_user` |
| (b) `env: ["TEST_DATABASE_URL"]` on `@budget/api#test` | task (b) | turbo.json edit |
| (c) root-file ownership = backend | task (c) | turbo.json edited by backend only |
| (d) per-amendment checklist in report | task (d) | this table, ticked in report |
| (e) contract artifacts unchanged | task (e) | no `schemas/`/`routers/` touched; `test_openapi_export` green; `git` shows openapi.json unmodified |
| (f) local PG 5443, committed 5433 | task (f) | verification commands + conftest default |
| §1 magnitude + NOT NULL `kind` on transactions | arch §1 | `transaction.py` + kind/amount CK tests + kind-survives-SET-NULL test |
| §2 hook create + `RUB` + `DEFAULT_BASE_CURRENCY` next to model | arch §2 | `on_after_register` + `profile.py` constant + hook test |
| §3 `String(16)` + CHECK for `kind` (no PG enum) | arch §3 | category/transaction `kind` columns + `ck_*_kind_valid` |
| §4 data migration 0003, 18 hardcoded UUIDs, `archived=false` explicit | arch §4 | 0003 seed table above |
| §5 no `receipt_id` | arch §5 | `transaction.py` (column omitted) |
| §6 ondelete: profiles/categories/tx.user CASCADE, tx.category SET NULL | arch §6 | FK declarations + two FK tests |
| §7 indexes: composite (explicit name) + `ix_categories_user_id`; no redundant tx.user_id / tx.category_id | arch §7 | `__table_args__` Index + `index=True` on category.user_id only |
| §8 no new domain/service/repo layer | arch §8 | only models/migrations/tests/hook touched |
| §9 split 0002/0003 + conftest DELETE-FROM-users | arch §9 | two migration files + conftest edit + seed-survives test |

## Open questions

1. **Test-scope trim (needs senior sign-off).** I test each CHECK *class* once
   (amount `>= 0`, `kind IN (...)`, currency regex — all on `transactions`) and
   exclude the profiles-side twins (`monthly_income_minor >= 0`,
   `base_currency` regex) and `categories.kind_valid` as redundant per CLAUDE.md.
   Residual risk: a typo in one migration CHECK line but not its structurally
   identical twin goes uncaught. I judge this acceptable (migration is
   hand-reviewed; probe confirms structure). Confirm, or ask for the twins.
2. **Backfill test mechanism (needs senior sign-off).** I chose the
   subprocess `downgrade 0002` → insert user → `upgrade 0003` approach (tests
   the real migration) over copying the backfill SQL into the test (robust but
   low-fidelity). It carries mid-suite migration-state fragility (mitigated by
   try/finally restore). Confirm the fidelity-over-robustness trade.
3. **`make test` doesn't exist** — the harness/brief says "run `make test`"; the
   repo exposes `uv run pytest` (package.json `test`) / turbo. I'll use the real
   command. Flagging in case a Makefile is expected to be added (out of scope
   here).

No blocking questions; defaults above are safe to proceed with.

## Risks

- **conftest cleanup change is load-bearing.** If `DELETE FROM users` is wrong
  (e.g. a future non-CASCADE FK is added), tests leak rows. Contained: the
  seed-count test fails loudly if seeds are wiped; the FK-cascade test fails if a
  cascade is missing.
- **Backfill test mutates global migration state mid-suite.** If it fails
  between `downgrade 0002` and `upgrade head`, the schema is left seed-less and
  subsequent tests cascade-fail. Mitigation: `try/finally` forcing
  `alembic upgrade head`, and it runs its own subprocess (session fixture
  untouched). Keep it the only test that manipulates revisions.
- **`icon` `String(16)` counts characters, not bytes** (PG `varchar`). The
  longest seed emoji is a ZWJ sequence (🧑‍💻 = 3 code points); all fit. A future
  longer emoji-sequence icon could exceed 16 — a 1.3 concern, not this task.
- **Migration `0003` UUID literals are the contract.** They must be pasted
  verbatim from the locked table above (2.2/2.5 will cache them). A copy error is
  caught by the seed stable-UUID spot-check test.
- **`on_after_register` failure semantics** (§2): unchanged risk, accepted and
  documented; not introduced by this plan, just inherited.

## Test guidance for QA

No endpoints change, so QA scope is narrow (architecture §Context). Live/curl
checks worth QA's attention that pytest does not cover:
- Confirm `git status` shows `openapi.json` and `packages/api-client` **unmodified** after the change (contract-unchanged, carry-forward (e)).
- Live `alembic upgrade head` then `downgrade base` then `upgrade head` against a real DB (reversibility on real PG, not just the session fixture).
- Run the empty-autogenerate probe against a live DB at head and eyeball the empty body (the meaningful-green gate; not a pytest).
- Spot-check `SELECT count(*), kind FROM categories WHERE user_id IS NULL GROUP BY kind` on a freshly migrated DB → 13 expense / 5 income.
