# QA Checklist: core-data-model (roadmap 1.2)

## Scope

This task ships **three new tables** (`profiles`, `categories`, `transactions`),
**two migrations** (`0002` schema DDL, `0003` seed + profiles backfill), the 18
system-category seed, a profiles backfill for pre-existing users, and **NO
endpoints** (CRUD APIs are 1.3/1.4; architecture "Scope contract" + task line 16).

### Why this checklist is NOT curl-shaped

Every prior QA checklist in this repo (see `auth-email-password`) had an HTTP wire
contract to prove against a running uvicorn. **This task has none** — it touches no
`schemas/`, `routers/`, or `openapi.json` (architecture "Module structure"). There is
nothing new to `curl`. QA's surface here is the **live database and the migration
CLI**: does the chain walk up and back down against a real Postgres that already holds
0001's data; do the named constraints, cascades, indexes and seed rows actually
materialise; and does the OpenAPI/generated-client contract stay byte-identical. So
Section B below is **psql + alembic commands**, not curl.

### QA's value here vs pytest (what we deliberately do NOT duplicate)

Per project convention QA declines to re-run what CI already pins. Backend's pytest
(`Section A`, owned by backend-engineer) runs **against the migrated schema** (conftest
`_migrated_schema` does `alembic upgrade head` on a real Postgres), so it already covers
ORM round-trips, IntegrityError-level constraint violations, and functional cascade
behaviour. QA does **not** re-list or re-run those. QA's distinct, live-only value:

1. **Backfill against pre-existing users** — pytest can never see this. conftest
   `TRUNCATE`s users before every test and `_migrated_schema` upgrades **before any
   user row exists**, so `0003`'s `INSERT INTO profiles SELECT id,'RUB' FROM users`
   always runs against an *empty* `users` table under pytest. The whole point of the
   backfill — copying **existing** users into `profiles` — is exercised **only** here
   (TC-M2/TC-M3). Highest-value live check.
2. **Full migration lifecycle** — pytest only does `upgrade head` + one closing
   `downgrade base`. It never tests the intermediate downgrades (`→0002`, `→0001`),
   the seed-vs-profiles **downgrade asymmetry** (architecture §9), or **re-upgrade
   stability** (same seed UUIDs after a rebuild). Live-only (TC-M4–M7).
3. **Catalog-level schema facts** — exact `conname`s, `confdeltype` ondelete codes,
   the two explicit index names + **absence** of a redundant `transactions.user_id`
   index (architecture §7), **absence** of `receipt_id` (§5), column storage types.
   Note (architecture §3): Alembic autogenerate does **not** diff CHECK constraints, so
   `alembic check` cannot catch a CHECK that is on the model but missing from the
   migration DDL — the live probes (Area C) are the only guard that the **named** CHECKs
   truly exist on the deployed schema.
4. **Contract-unchanged proof** — a repo/CLI fact (git diff + empty-autogenerate),
   not a pytest assertion (TC-O1/O2).

**Intentional overlap, stated:** the constraint probes (Area C) and cascade probes
(Area X) overlap functionally with backend pytest. They are kept because they assert the
**exact named constraint** in the error (the greppable-name contract, architecture §3)
and prove it on the **migration-built** schema at head — value pytest's ORM-path
IntegrityError assertions do not guarantee at the `conname` level. See the Coverage note
at the bottom for the full pytest-vs-live split.

---

## Preconditions

**Two ports — do not confuse them (machine-specific safety fact, carried from the
`auth-email-password` checklist and task line 24):**

| DB (this machine) | Port | Notes |
|---|---|---|
| this project's Postgres — `budget` + `budget_test` | **5443** | container `budget-postgres-1`; the ONLY container QA touches, via `psql`/alembic only — never `docker stop/start` |
| committed default in `conftest`/compose | 5433 | a **FOREIGN** project's container on this machine — **never connect, never touch** |

- All checks target the **test** DB on **5443** via `TEST_DATABASE_URL`. The committed
  `5433` in `conftest.py` line 30 is a repo constant, NOT this machine's port.
- **Area M is destructive to the DB *schema*** (it runs `alembic downgrade base` and
  cycles the whole chain). It must **own** the test DB for the duration — run it when
  **no pytest session is active** (pytest's `_migrated_schema` also cycles the schema).
  The DB is expendable: the migrations rebuild it. Areas C/X/G/S run afterward at head.
- Postgres verified live: **PostgreSQL 17**, `gen_random_uuid()` is built-in (used by the
  probe INSERTs below). `inet_server_port()` returns the container-internal `5432`; the
  host mapping is `5443` — use `\conninfo` (TC-P1) to confirm the client port, not
  `inet_server_port()`.

**Shell setup for Section B (run once):**

```bash
API=/Users/nikitazaretski/work/budget/apps/api
ROOT=/Users/nikitazaretski/work/budget
PGURL="postgresql://budget:budget@localhost:5443/budget_test"          # for psql
ADB="postgresql+asyncpg://budget:budget@localhost:5443/budget_test"    # for alembic (env.py sources Settings.database_url → needs +asyncpg)
BASE_SHA=19f4e36   # pre-task HEAD (task.md line 5); the commit BEFORE core-data-model landed
```

Fixed probe UUIDs (chosen so failing INSERTs leave nothing behind and rows are easy to
clean up):

```bash
U0=00000000-0000-0000-0000-0000000000a0   # backfill user (created at rev 0001)
UP=00000000-0000-0000-0000-0000000000b0   # constraint-probe user (no profile at head)
UC=00000000-0000-0000-0000-0000000000c0   # cascade user-delete
CC=00000000-0000-0000-0000-0000000000c1   #   its custom category
UD=00000000-0000-0000-0000-0000000000d0   # cascade category-delete
CD=00000000-0000-0000-0000-0000000000d1   #   its category (to be deleted)
TD=00000000-0000-0000-0000-0000000000d2   #   its transaction (must survive SET NULL)
```

### TC-P1: connected to the test DB on port 5443 (not 5433)
- **Command**:
```bash
psql "$PGURL" -c '\conninfo'
```
- **Expected**: reports database `budget_test`, host `localhost`, **port `5443`**. If it
  says `5433`, STOP — wrong (foreign) container.
- **Actual**: `You are connected to database "budget_test" as user "budget" on host "localhost" (address "::1") at port "5443".` — confirms port 5443, DB budget_test. STOP gate cleared.
- **Status**: ✅ pass

### TC-P2: alembic reachable, reports a current revision
- **Command**:
```bash
cd "$API" && DATABASE_URL="$ADB" uv run alembic current
```
- **Expected**: prints a revision (e.g. `0003 (head)`), or nothing if at base — either
  way the CLI runs cleanly against 5443. Establishes the baseline before Area M.
- **Actual**: CLI ran cleanly against 5443; printed only the two INFO lines (`Context impl PostgresqlImpl`, `Will assume transactional DDL`) and no revision — DB was at **base** before Area M. Baseline established.
- **Status**: ✅ pass

### TC-P3: migration chain has exactly three revisions 0001→0002→0003
- **Command**:
```bash
cd "$API" && DATABASE_URL="$ADB" uv run alembic history
```
- **Expected**: linear history `0001 -> 0002 -> 0003 (head)` (labels/messages free); no
  branches, no extra revisions.
- **Actual**: Linear, exactly three revisions, no branches:
```
0002 -> 0003 (head), seed system categories and backfill profiles
0001 -> 0002, core tables
<base> -> 0001, users and refresh_tokens
```
- **Status**: ✅ pass

---

## Section A: Pytest test cases

*Owned by backend-engineer, written in `tests/` during /implement. The authoritative
suite is plan.md's **final 7-test list in `tests/test_core_model.py`** (Test plan
(pytest)) — QA does not prescribe its contents, only runs it green. Per grooming-review
AM-3/R2b there is **NO `tests/test_migrations.py`**: the migration file is frozen once
merged, so the backfill and the intermediate-downgrade path are verified **live-only** —
**Area M below owns them as a mandatory merge gate** (R2b), not pytest. QA verifies the 7
tests by running `pnpm --filter @budget/api test` (there is **no Makefile** —
`apps/api/package.json` `test` = `uv run pytest`; run with
`TEST_DATABASE_URL=postgresql+asyncpg://budget:budget@localhost:5443/budget_test`) and
confirming all green at /test. If any pytest fails, escalate to senior-lead — do not fix
backend code.* The one pytest pin QA leans on rather than re-runs is **the §9 landmine —
"18 system categories survive the per-test cleanup"** (conftest `TRUNCATE ... CASCADE`
becomes row-level `DELETE FROM users` so `user_id IS NULL` seeds survive); this is
covered inside the 7 tests by the **autouse-cleanup seed-count test**
(`test_seed_present_and_stable`: count==18 asserted *after* the cleanup ran). See the
Coverage note for the full pytest-vs-live split.

---

## Section B: psql + alembic command test cases
*Owned by qa-engineer. Run against the live test DB / repo during /test.*

### Area M — Migration lifecycle & backfill (ordered; run as ONE sequence)

> **Order dependency (SKILL rule 8):** these seven TCs are a single stateful script —
> each starts from the DB state the previous one left. Run top-to-bottom. Destructive to
> the schema; owns the DB (see Preconditions). All alembic calls need
> `cd "$API" && DATABASE_URL="$ADB"`.

#### TC-M1: base → head walks 0001→0002→0003; current = 0003
- **Command**:
```bash
cd "$API"
DATABASE_URL="$ADB" uv run alembic downgrade base
DATABASE_URL="$ADB" uv run alembic upgrade head
DATABASE_URL="$ADB" uv run alembic current
```
- **Expected**: the upgrade prints three steps —
  `Running upgrade  -> 0001`, `Running upgrade 0001 -> 0002`,
  `Running upgrade 0002 -> 0003`; `alembic current` = `0003 (head)`.
- **Actual**: downgrade base clean; upgrade printed the three expected steps (`-> 0001, users and refresh_tokens`, `0001 -> 0002, core tables`, `0002 -> 0003, seed system categories and backfill profiles`); `alembic current` = `0003 (head)`.
- **Status**: ✅ pass

#### TC-M2: backfill live proof — a user that existed at 0001 gets a RUB profile
- **Setup / why**: this is the check pytest structurally cannot do (see Scope §1). Create
  a user **at revision 0001** (before `profiles` exists), then upgrade the rest of the
  chain and prove `0003`'s backfill materialised the profile.
- **Command**:
```bash
cd "$API"
DATABASE_URL="$ADB" uv run alembic downgrade base
DATABASE_URL="$ADB" uv run alembic upgrade 0001
psql "$PGURL" -c "INSERT INTO users (id,email,hashed_password) VALUES ('$U0','qa-backfill@example.com','x');"
DATABASE_URL="$ADB" uv run alembic upgrade head
psql "$PGURL" -tAc "SELECT base_currency FROM profiles WHERE user_id='$U0';"
```
- **Expected**: at 0001 the INSERT succeeds (`INSERT 0 1`); after `upgrade head` the
  final query returns exactly **`RUB`** — `0003` backfilled the pre-existing user.
- **Actual**: user inserted at 0001 (`INSERT 0 1`); after `upgrade head` (0002→0003 ran) the query returned exactly `RUB`. Backfill copied the pre-existing user into `profiles`. This is the pytest-unreachable check — confirmed live.
- **Status**: ✅ pass

#### TC-M3: backfill idempotency — re-running the INSERT is a no-op
- **Setup**: DB at head from TC-M2; `$U0` already has a profile.
- **Command**:
```bash
psql "$PGURL" -c "INSERT INTO profiles (user_id, base_currency) SELECT id, 'RUB' FROM users ON CONFLICT (user_id) DO NOTHING;"
```
- **Expected**: `INSERT 0 0` — `ON CONFLICT (user_id) DO NOTHING` inserts nothing
  (architecture §9.2 idempotency-by-construction; re-runnable to repair an orphaned user
  per §2).
- **Actual**: `INSERT 0 0` — `ON CONFLICT (user_id) DO NOTHING` inserted nothing (`$U0` already had a profile). Idempotent by construction.
- **Status**: ✅ pass

#### TC-M4: capture seed UUIDs at head (baseline for stability, TC-M7)
- **Setup**: DB at head.
- **Command**:
```bash
psql "$PGURL" -tAc "SELECT id FROM categories WHERE user_id IS NULL ORDER BY id;" > /tmp/seed_ids_run1.txt
wc -l < /tmp/seed_ids_run1.txt
```
- **Expected**: **18** ids captured.
- **Actual**: `wc -l` = **18** ids written to `/tmp/seed_ids_run1.txt`.
- **Status**: ✅ pass

#### TC-M5: downgrade to 0002 — seeds gone, backfilled profile REMAINS (§9 asymmetry)
- **Setup**: DB at head; `$U0` profile present (TC-M2).
- **Command**:
```bash
cd "$API" && DATABASE_URL="$ADB" uv run alembic downgrade 0002
psql "$PGURL" -tAc "SELECT count(*) FROM categories WHERE user_id IS NULL;"   # seeds
psql "$PGURL" -tAc "SELECT count(*) FROM profiles WHERE user_id='$U0';"       # asymmetry
DATABASE_URL="$ADB" uv run alembic current
```
- **Expected**: seed count = **0** (0003 downgrade deletes the 18 by id); `$U0` profile
  count = **1** — backfilled profiles are deliberately **left in place** on 0003
  downgrade (architecture §9, "0003 downgrade does NOT delete profiles"). `current` =
  `0002`.
- **Actual**: `downgrade 0003 -> 0002` ran; seed count = **0** (18 deleted by id); `$U0` profile count = **1** (backfilled profile deliberately left in place — §9 asymmetry confirmed); `current` = `0002`.
- **Status**: ✅ pass

#### TC-M6: downgrade to 0001 — all three new tables gone
- **Setup**: DB at 0002 from TC-M5.
- **Command**:
```bash
cd "$API" && DATABASE_URL="$ADB" uv run alembic downgrade 0001
psql "$PGURL" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_name IN ('profiles','categories','transactions');"
DATABASE_URL="$ADB" uv run alembic current
```
- **Expected**: table count = **0** (0002 downgrade drops transactions→categories→
  profiles); `current` = `0001`. `users`/`refresh_tokens` still exist (untouched).
- **Actual**: `downgrade 0002 -> 0001` ran; new-table count = **0** (profiles/categories/transactions all dropped); `current` = `0001`; `users`+`refresh_tokens` count = **2** (untouched).
- **Status**: ✅ pass

#### TC-M7: re-upgrade head — seeds back with IDENTICAL UUIDs (stable ids)
- **Setup**: DB at 0001 from TC-M6; `$U0` still exists in `users`.
- **Command**:
```bash
cd "$API" && DATABASE_URL="$ADB" uv run alembic upgrade head
psql "$PGURL" -tAc "SELECT id FROM categories WHERE user_id IS NULL ORDER BY id;" > /tmp/seed_ids_run2.txt
diff /tmp/seed_ids_run1.txt /tmp/seed_ids_run2.txt && echo "STABLE_IDS"
psql "$PGURL" -tAc "SELECT base_currency FROM profiles WHERE user_id='$U0';"   # backfill re-ran
```
- **Expected**: `diff` is empty → prints **`STABLE_IDS`** (hardcoded literal UUIDs,
  architecture §4 — same 18 ids across a rebuild); `$U0` profile back with `RUB`
  (backfill re-ran against the still-present user). Leaves DB at head for Areas C/X/G/S.
- **Actual**: `upgrade 0002 -> 0003` ran; `diff` of run1 vs run2 seed id lists was empty → printed **`STABLE_IDS`** (same 18 hardcoded UUIDs across rebuild); `$U0` profile back with `RUB` (backfill re-ran). DB left at head.
- **Status**: ✅ pass

---

### Area C — Constraint probes (each INSERT expects a specific NAMED constraint)

> **Setup (run once):** DB at head. Create a probe user with **no profile** (a
> psql-inserted user post-backfill has none — the hook doesn't run without the API):
> ```bash
> psql "$PGURL" -c "INSERT INTO users (id,email,hashed_password) VALUES ('$UP','qa-probe@example.com','x');"
> ```
> Each failing INSERT below is a single statement in its own implicit transaction, so it
> **rolls back cleanly** — `$UP` stays profile-less/row-less between probes.
> Constraint names: all six `ck_*` names below are **pinned as the binding migration
> contract** for 0002 (grooming-review R1/AM-1) — not inferred; the Area C error-message
> expectations and TC-G1's catalog list are unchanged.

#### TC-C1: base_currency format CHECK rejects lowercase / short / digits
- **Command**:
```bash
psql "$PGURL" -c "INSERT INTO profiles (user_id,base_currency) VALUES ('$UP','rub');"    # lowercase
psql "$PGURL" -c "INSERT INTO profiles (user_id,base_currency) VALUES ('$UP','US');"     # 2-letter
psql "$PGURL" -c "INSERT INTO profiles (user_id,base_currency) VALUES ('$UP','US1');"    # digit
```
- **Expected**: all three `ERROR: ... violates check constraint
  "ck_profiles_base_currency_format"` (pattern `^[A-Z]{3}$`, architecture §2). Positive
  control: `('$UP','USD')` would succeed (do NOT commit it — it consumes the PK; if run,
  `DELETE FROM profiles WHERE user_id='$UP';`).
- **Actual**: all three rejected with `ERROR: new row for relation "profiles" violates check constraint "ck_profiles_base_currency_format"` (for `rub`, `US`, `US1`). Exact named constraint confirmed on the migration-built schema.
- **Status**: ✅ pass

#### TC-C2: monthly_income_minor non-negative CHECK
- **Command**:
```bash
psql "$PGURL" -c "INSERT INTO profiles (user_id,base_currency,monthly_income_minor) VALUES ('$UP','USD',-1);"
```
- **Expected**: `ERROR: ... "ck_profiles_monthly_income_minor_non_negative"` (§2). (NULL
  passes CHECKs in PG — no probe needed; that's the nullable-column default.)
- **Actual**: `ERROR: new row for relation "profiles" violates check constraint "ck_profiles_monthly_income_minor_non_negative"` — rejected as expected.
- **Status**: ✅ pass

#### TC-C3: transactions.amount_minor non-negative CHECK
- **Command**:
```bash
psql "$PGURL" -c "INSERT INTO transactions (id,user_id,amount_minor,kind,currency,occurred_at) VALUES (gen_random_uuid(),'$UP',-1,'expense','USD','2026-07-24');"
```
- **Expected**: `ERROR: ... "ck_transactions_amount_minor_non_negative"` (magnitude
  convention, architecture §1).
- **Actual**: `ERROR: new row for relation "transactions" violates check constraint "ck_transactions_amount_minor_non_negative"` — rejected as expected.
- **Status**: ✅ pass

#### TC-C4: transactions.kind CHECK rejects 'transfer' (only expense|income today)
- **Command**:
```bash
psql "$PGURL" -c "INSERT INTO transactions (id,user_id,amount_minor,kind,currency,occurred_at) VALUES (gen_random_uuid(),'$UP',100,'transfer','USD','2026-07-24');"
```
- **Expected**: `ERROR: ... "ck_transactions_kind_valid"` — `'transfer'` is the future
  stage-5 value, rejected now (architecture §1 "Future transfers become a third kind").
- **Actual**: `ERROR: new row for relation "transactions" violates check constraint "ck_transactions_kind_valid"` — `'transfer'` rejected as expected.
- **Status**: ✅ pass

#### TC-C5: transactions.currency format CHECK
- **Command**:
```bash
psql "$PGURL" -c "INSERT INTO transactions (id,user_id,amount_minor,kind,currency,occurred_at) VALUES (gen_random_uuid(),'$UP',100,'expense','rub','2026-07-24');"
```
- **Expected**: `ERROR: ... "ck_transactions_currency_format"` (pattern `^[A-Z]{3}$`,
  resulting-schema).
- **Actual**: `ERROR: new row for relation "transactions" violates check constraint "ck_transactions_currency_format"` — `'rub'` rejected as expected.
- **Status**: ✅ pass

#### TC-C6: transactions.kind is NOT NULL
- **Command**:
```bash
psql "$PGURL" -c "INSERT INTO transactions (id,user_id,amount_minor,currency,occurred_at) VALUES (gen_random_uuid(),'$UP',100,'USD','2026-07-24');"
```
- **Expected**: `ERROR: null value in column "kind" ... violates not-null constraint`
  (§1 verdict: kind is the source of truth, NOT NULL on transactions).
- **Actual**: `ERROR: null value in column "kind" of relation "transactions" violates not-null constraint` — rejected as expected.
- **Status**: ✅ pass

#### TC-C7: categories.kind CHECK rejects 'transfer'
- **Command**:
```bash
psql "$PGURL" -c "INSERT INTO categories (id,user_id,name,kind) VALUES (gen_random_uuid(),'$UP','X','transfer');"
```
- **Expected**: `ERROR: ... "ck_categories_kind_valid"` (§3).
- **Actual**: `ERROR: new row for relation "categories" violates check constraint "ck_categories_kind_valid"` — `'transfer'` rejected as expected.
- **Status**: ✅ pass

#### TC-C8: zero amount is ACCEPTED (>= 0 verdict, not > 0)
- **Command**:
```bash
psql "$PGURL" -c "INSERT INTO transactions (id,user_id,amount_minor,kind,currency,occurred_at) VALUES (gen_random_uuid(),'$UP',0,'expense','USD','2026-07-24');"
psql "$PGURL" -c "DELETE FROM transactions WHERE user_id='$UP';"   # cleanup (this one COMMITS)
```
- **Expected**: `INSERT 0 1` — zero passes `>= 0` (architecture §resulting-schema +
  open-question 5: DB allows zero, API policy deferred to 1.4). Cleanup removes it.
- **Actual**: `INSERT 0 1` — zero passed `>= 0`; cleanup `DELETE 1` removed the committed row.
- **Status**: ✅ pass

---

### Area X — Cascade / SET NULL probes (the §6 ondelete verdicts, live)

#### TC-X1: delete a user cascades to their data; the 18 system categories SURVIVE
- **Setup**:
```bash
psql "$PGURL" <<SQL
INSERT INTO users (id,email,hashed_password) VALUES ('$UC','qa-cascade1@example.com','x');
INSERT INTO profiles (user_id,base_currency) VALUES ('$UC','USD');
INSERT INTO categories (id,user_id,name,kind) VALUES ('$CC','$UC','My Cat','expense');
INSERT INTO transactions (id,user_id,amount_minor,kind,currency,category_id,occurred_at) VALUES (gen_random_uuid(),'$UC',500,'expense','USD','$CC','2026-07-24');
INSERT INTO refresh_tokens (token,user_id,created_at) VALUES ('qa-cascade1-refresh-token-aaaaaaaaaaaaaaaaa','$UC',now());
SQL
```
- **Command**:
```bash
psql "$PGURL" -tAc "SELECT count(*) FROM categories WHERE user_id IS NULL;"   # before: 18
psql "$PGURL" -c "DELETE FROM users WHERE id='$UC';"
psql "$PGURL" -tAc "SELECT
  (SELECT count(*) FROM profiles       WHERE user_id='$UC'),
  (SELECT count(*) FROM categories     WHERE user_id='$UC'),
  (SELECT count(*) FROM transactions   WHERE user_id='$UC'),
  (SELECT count(*) FROM refresh_tokens WHERE user_id='$UC'),
  (SELECT count(*) FROM categories     WHERE user_id IS NULL);"
```
- **Expected**: before-count `18`; `DELETE 1`; result row `0|0|0|0|18` — profile, custom
  category, transaction and refresh token all CASCADE-deleted (§6 all-CASCADE via
  `user_id`), while the **system categories (`user_id IS NULL`) survive** because they do
  not participate in any user FK (§6).
- **Actual**: before-count = `18`; `DELETE 1`; result row = `0|0|0|0|18` — profile, custom category, transaction and refresh token all CASCADE-deleted; the 18 system categories (`user_id IS NULL`) survived.
- **Status**: ✅ pass

#### TC-X2: delete a category SET-NULLs the transaction; kind & amount UNCHANGED (§1↔§6)
- **Setup**:
```bash
psql "$PGURL" <<SQL
INSERT INTO users (id,email,hashed_password) VALUES ('$UD','qa-cascade2@example.com','x');
INSERT INTO categories (id,user_id,name,kind) VALUES ('$CD','$UD','Groceries','expense');
INSERT INTO transactions (id,user_id,amount_minor,kind,currency,category_id,occurred_at) VALUES ('$TD','$UD',500,'expense','USD','$CD','2026-07-24');
SQL
```
- **Command**:
```bash
psql "$PGURL" -c "DELETE FROM categories WHERE id='$CD';"
psql "$PGURL" -tAc "SELECT category_id, kind, amount_minor FROM transactions WHERE id='$TD';"
psql "$PGURL" -c "DELETE FROM users WHERE id='$UD';"   # cleanup
```
- **Expected**: `DELETE 1` (category deletes despite the referencing transaction — NOT
  blocked); result `|expense|500` → `category_id = NULL` (SET NULL, §6), **`kind` still
  `expense` and `amount_minor` still `500`**. This is THE §1 design contrast: the
  transaction degrades to "uncategorized" but keeps its own kind/amount — it did NOT lose
  meaning, precisely because kind lives on the transaction, not the (now-gone) category.
- **Actual**: `DELETE 1` (category deleted, not blocked by the referencing transaction); transaction row = `|expense|500` → `category_id` = NULL (SET NULL), `kind` still `expense`, `amount_minor` still `500`. §1↔§6 contrast confirmed. User cleaned up (`DELETE 1`).
- **Status**: ✅ pass

---

### Area G — Catalog / schema checks (names, ondelete, indexes, types, absences)

#### TC-G1: the six named CHECK constraints exist
- **Command**:
```bash
psql "$PGURL" -tAc "SELECT conname FROM pg_constraint WHERE contype='c' AND conname LIKE 'ck_%' ORDER BY 1;"
```
- **Expected** (CHECKs live in `pg_constraint`, not `pg_indexes` — the AM-J lesson):
```
ck_categories_kind_valid
ck_profiles_base_currency_format
ck_profiles_monthly_income_minor_non_negative
ck_transactions_amount_minor_non_negative
ck_transactions_currency_format
ck_transactions_kind_valid
```
- **Actual**: exactly the six expected names present, in order:
```
ck_categories_kind_valid
ck_profiles_base_currency_format
ck_profiles_monthly_income_minor_non_negative
ck_transactions_amount_minor_non_negative
ck_transactions_currency_format
ck_transactions_kind_valid
```
- **Status**: ✅ pass

#### TC-G2: the four FK constraints with correct ondelete (confdeltype)
- **Command**:
```bash
psql "$PGURL" -tAc "SELECT conname, confdeltype FROM pg_constraint WHERE contype='f' AND conname LIKE 'fk_%' AND conrelid::regclass::text IN ('profiles','categories','transactions') ORDER BY 1;"
```
- **Expected** (`confdeltype`: `c`=CASCADE, `n`=SET NULL):
```
fk_categories_users_user_id|c
fk_profiles_users_user_id|c
fk_transactions_categories_category_id|n
fk_transactions_users_user_id|c
```
  All three `user_id` FKs CASCADE; `transactions.category_id` is **SET NULL** (§6).
- **Actual**: exact match:
```
fk_categories_users_user_id|c
fk_profiles_users_user_id|c
fk_transactions_categories_category_id|n
fk_transactions_users_user_id|c
```
  Three user_id FKs = CASCADE (`c`), category_id = SET NULL (`n`).
- **Status**: ✅ pass

#### TC-G3: the three primary keys exist
- **Command**:
```bash
psql "$PGURL" -tAc "SELECT conname FROM pg_constraint WHERE contype='p' AND conrelid::regclass::text IN ('profiles','categories','transactions') ORDER BY 1;"
```
- **Expected**: `pk_categories`, `pk_profiles`, `pk_transactions` (profiles' PK is
  `user_id`, doubling as the FK — §2).
- **Actual**: `pk_categories`, `pk_profiles`, `pk_transactions` — all three present.
- **Status**: ✅ pass

#### TC-G4: exactly the two explicit indexes; NO redundant transactions.user_id index
- **Command**:
```bash
psql "$PGURL" -tAc "SELECT indexname FROM pg_indexes WHERE tablename IN ('profiles','categories','transactions') AND indexname LIKE 'ix_%' ORDER BY 1;"
psql "$PGURL" -tAc "SELECT count(*) FROM pg_indexes WHERE indexname='ix_transactions_user_id';"
```
- **Expected** (indexes live in `pg_indexes`, not `pg_constraint`): first query returns
  exactly `ix_categories_user_id` and `ix_transactions_user_id_occurred_at` (architecture
  §7); second query = **`0`** — the standalone `transactions.user_id` index is
  deliberately absent (the composite's leading column serves it; §7 "strictly dominated
  index" deviation from the sketch).
- **Actual**: first query returned exactly `ix_categories_user_id` and `ix_transactions_user_id_occurred_at`; second query = `0` — no redundant standalone `ix_transactions_user_id`.
- **Status**: ✅ pass

#### TC-G5: transactions has NO receipt_id column (§5 omission)
- **Command**:
```bash
psql "$PGURL" -tAc "SELECT count(*) FROM information_schema.columns WHERE table_name='transactions' AND column_name='receipt_id';"
```
- **Expected**: `0` — `receipt_id` is deferred to task 2.1 (architecture §5, deviation
  from the architecture sketch, recorded).
- **Actual**: `0` — no `receipt_id` column on `transactions` (deferred to 2.1, confirmed).
- **Status**: ✅ pass

#### TC-G6: column storage types match the resulting-schema
- **Command**:
```bash
psql "$PGURL" -tAc "SELECT column_name, data_type FROM information_schema.columns WHERE table_name='transactions' AND column_name IN ('amount_minor','occurred_at','created_at','kind','currency') ORDER BY column_name;"
psql "$PGURL" -tAc "SELECT column_name, data_type FROM information_schema.columns WHERE table_name='profiles' AND column_name IN ('monthly_income_minor','base_currency') ORDER BY column_name;"
```
- **Expected** (architecture "Resulting schema"):
  `amount_minor|bigint`, `occurred_at|date`, `created_at|timestamp with time zone`,
  `kind|character varying`, `currency|character varying`;
  `monthly_income_minor|bigint`, `base_currency|character varying`.
  (Spot-checks the load-bearing types: BigInteger amounts, `Date` occurred_at, tz-aware
  created_at.)
- **Actual**: transactions — `amount_minor|bigint`, `created_at|timestamp with time zone`, `currency|character varying`, `kind|character varying`, `occurred_at|date`; profiles — `base_currency|character varying`, `monthly_income_minor|bigint`. All match resulting-schema.
- **Status**: ✅ pass

---

### Area S — Seed content (the 18 system categories)

#### TC-S1: 18 rows, 13 expense + 5 income
- **Command**:
```bash
psql "$PGURL" -tAc "SELECT kind, count(*) FROM categories WHERE user_id IS NULL GROUP BY kind ORDER BY kind;"
```
- **Expected**: `expense|13` then `income|5` (total 18, architecture §4). These counts are
  the **hard** assertion (names are PM-editable — see TC-S3).
- **Actual**: `expense|13` then `income|5` (total 18). Exact match.
- **Status**: ✅ pass

#### TC-S2: every seed is a system row (user_id NULL) and NOT archived
- **Command**:
```bash
psql "$PGURL" -tAc "SELECT
  (SELECT count(*) FROM categories WHERE user_id IS NULL),
  (SELECT count(*) FROM categories WHERE user_id IS NULL AND archived IS FALSE),
  (SELECT count(*) FROM categories WHERE user_id IS NULL AND archived IS TRUE);"
```
- **Expected**: `18|18|0` — all 18 are `user_id IS NULL` and `archived=false` (§4,
  explicit `archived=false` in the seed; §9 defaults).
- **Actual**: `18|18|0` — all 18 seeds are `user_id IS NULL` and `archived=false`, none archived.
- **Status**: ✅ pass

#### TC-S3: seed names match the architecture §4 proposal (SOFT — PM may have edited)
- **Command**:
```bash
psql "$PGURL" -tAc "SELECT kind, name FROM categories WHERE user_id IS NULL ORDER BY kind, name;"
```
- **Expected** (architecture §4; note §4 says names/emojis are "freely editable — zero
  migration-design impact", so treat mismatches as *check against the accepted seed
  list*, NOT a failure):
  - expense (13): Продукты, Кафе и рестораны, Транспорт, Жильё, Здоровье, Одежда,
    Развлечения, Связь и интернет, Подписки, Подарки, Путешествия, Образование, Прочее
  - income (5): Зарплата, Фриланс, Подарки, Проценты и кэшбэк, Прочее
  - duplicate names across kinds ("Подарки", "Прочее") are intentional and legal (§4 —
    no unique constraint on name).
- **Actual**: all 18 names match the accepted §4 list. expense (13): Жильё, Здоровье, Кафе и рестораны, Образование, Одежда, Подарки, Подписки, Продукты, Прочее, Путешествия, Развлечения, Связь и интернет, Транспорт. income (5): Зарплата, Подарки, Проценты и кэшбэк, Прочее, Фриланс. Duplicate "Подарки"/"Прочее" across kinds present as expected. (Listed sorted by kind,name.)
- **Status**: ✅ pass

---

### Area O — Contract unchanged (the "no schema-visible API change" claim, §Scope)

#### TC-O1: openapi.json and generated client are byte-identical to pre-task HEAD
- **Command**:
```bash
cd "$ROOT"
git diff --stat "$BASE_SHA" HEAD -- apps/api/openapi.json packages/api-client/src/generated/
echo "exit=$?"
git diff --exit-code -- apps/api/openapi.json packages/api-client/src/generated/; echo "worktree_clean_exit=$?"
```
- **Expected**: the `git diff --stat` against `$BASE_SHA` prints **nothing** (no files
  changed by the implementation); worktree diff exit = `0`. Carry-forward (e) is NOT
  triggered — nothing to regenerate (architecture §Scope). If either shows a change,
  FAIL: the task silently altered the wire contract.
- **Actual**: `git diff --stat 19f4e36 HEAD -- <paths>` printed nothing (`exit=0`); worktree `git diff --exit-code` for the same paths exited `0` (clean). No wire-contract change. Observation: `git rev-parse --short HEAD` = `19f4e36`, i.e. HEAD currently equals BASE_SHA, so the BASE↔HEAD diff is trivially empty; the contract-unchanged claim is nonetheless positively corroborated by the clean worktree diff AND by TC-O2 (`alembic check` clean at head proves the migrated schema matches the models with no drift).
- **Status**: ✅ pass

#### TC-O2: empty-autogenerate gate is green at head
- **Command**:
```bash
cd "$API" && DATABASE_URL="$ADB" uv run alembic check
```
- **Expected**: `No new upgrade operations detected.` — model metadata matches the
  migrated schema (tables/columns/indexes/FKs). **Caveat (architecture §3):** autogenerate
  does NOT diff CHECK constraints, so this passing does NOT prove the CHECKs exist — that
  is what Area C + TC-G1 independently verify. This is the project's exact gate command
  (`pnpm openapi` regenerates the artifacts; `alembic check` gates the schema — same as
  `auth-email-password` TC-E1).
- **Actual**: `No new upgrade operations detected.` — model metadata matches the migrated schema at head (no drift). (Caveat per §3 stands: autogenerate does not diff CHECKs; those are independently proven by Area C + TC-G1.)
- **Status**: ✅ pass

---

## Coverage note — what pytest pins (NOT duplicated) vs what only live checks catch

**Pinned by backend pytest (Section A — `tests/test_core_model.py`, the 7 tests) — QA
does NOT re-run as psql:**
- ORM-level constraint violations raised as `IntegrityError` for the three CHECK
  *classes* on `transactions` (amount `>= 0`, `kind IN (...)`, currency regex) — the
  *functional* rejection is pytest's; QA's Area C adds only the **`conname`-in-error** +
  migration-schema angle **and** the excluded profiles/categories twins (TC-C1/C2/C7).
- Functional cascade behaviour via the ORM session — user-delete CASCADE and
  category-delete SET-NULL-with-`kind`-survives (the §1 headline test). Happy-path
  insertability of a full valid row is covered *incidentally* by these (they insert and
  read valid rows back); there is no separate bare round-trip test — excluded per the
  no-redundant-test policy (plan "Evaluated and EXCLUDED").
- The hook go-forward wiring — `test_register_creates_rub_profile` pins that registering
  creates a `RUB` profile (carry-forward (a), go-forward half).
- The **§9 landmine pin**: "18 system categories survive the per-test cleanup" (conftest
  `DELETE FROM users` instead of `TRUNCATE ... CASCADE`), proven by the **autouse-cleanup
  seed-count test** (`test_seed_present_and_stable`: count==18 after cleanup ran). This is
  a **pytest** test; QA does not re-run the per-test cleanup — TC-X1 independently proves
  system rows survive a user delete, and TC-S1 proves the 18 exist, but the "survives
  repeated test cleanup" invariant is pytest's.
- **NOT pinned by pytest (live-only, see below):** the migration up/down cycle and the
  backfill — there is no `test_migrations.py` (AM-3); Area M owns these.

**Live-only — NOT reachable by pytest, so owned here:**
- **Backfill against pre-existing users** (TC-M2/M3) — pytest always backfills an empty
  `users` table (conftest truncates before, migrates before any user exists). The core
  behaviour of the backfill is exercised **only** here. Per grooming-review AM-3/R2b
  (`test_migrations.py` rejected), **Area M is a MANDATORY merge gate for this task** —
  /test cannot be skipped; TC-M2/M3 (+ TC-M5–M7 for the downgrade path) are the sole
  proof of the backfill and the "downgrade path tested" carry-forward.
- **Intermediate downgrades + downgrade asymmetry** (TC-M5/M6) — pytest never asserts the
  cycle; conftest only does `upgrade head` (+ a closing `downgrade base` teardown, not a
  test assertion), so it never proves "0003-down keeps profiles, 0002-down drops the
  tables". Owned by Area M (part of the AM-3 merge gate above).
- **Stable seed UUIDs across a rebuild** (TC-M4/M7) — pytest never rebuilds mid-session.
- **Catalog facts**: exact `confdeltype` ondelete codes, absence of a redundant
  `transactions.user_id` index (TC-G4), absence of `receipt_id` (TC-G5) — schema-level,
  not behaviour pytest asserts.
- **Contract-unchanged** (TC-O1/O2) — a repo/CLI fact.

**Intentional overlap (stated, like `auth-email-password`'s rotation checks):** Area C
constraint probes and Area X cascade probes overlap functionally with pytest. Kept
because they assert the **exact named constraint** (greppable-name contract, §3) on the
**migration-built** schema — and because `alembic check` cannot see missing CHECKs (§3),
the live probes are the only guard that the named CHECKs truly shipped in the DDL.

---

## Summary (skeleton — fill at /test)

- **Shape**: DB-verification checklist (psql + alembic), NOT curl — this task ships
  migrations/tables/seed/backfill and **no endpoints** (justified in Scope).
- **Total planned checks: 31** — Preconditions 3 (P1–P3), Area M 7 (M1–M7),
  Area C 8 (C1–C8), Area X 2 (X1–X2), Area G 6 (G1–G6), Area S 3 (S1–S3), Area O 2 (O1–O2).

### Section A (pytest) — verified via `uv run pytest -q` (TEST_DATABASE_URL → 5443)
- Total: **31** — ✅ Pass: **31** — ❌ Fail: **0**
- Run at /test on 2026-07-24 after Area M restored the DB to head: `31 passed in 4.74s`.
- Note: pytest's session teardown (`conftest` `downgrade base`) left the DB at **base**, not head. QA re-ran `alembic upgrade head` afterward to satisfy the "leave DB at head" rule (see final-state note below). This is expected pytest behaviour, not a failure.

### Section B (psql + alembic command)
- Total: **31** — ✅ Pass: **31** — ❌ Fail: **0** — ⚠ Caveated: **0** — 🚫 Blocked: **0**
- Per area (all pass): Preconditions P1–P3 (3/3), Area M M1–M7 (7/7), Area C C1–C8 (8/8), Area X X1–X2 (2/2), Area G G1–G6 (6/6), Area S S1–S3 (3/3), Area O O1–O2 (2/2).
- **TC-P1 STOP gate cleared**: connected to `budget_test` on port **5443** (not the foreign 5433). No docker touched.
- **TC-O1 note (not a caveat)**: HEAD currently equals BASE_SHA `19f4e36`, so the BASE↔HEAD diff of the contract paths is trivially empty; the contract-unchanged claim is positively corroborated by the clean worktree diff AND TC-O2 (`alembic check` = "No new upgrade operations detected." at head).

### Final DB state (safety)
- DB left at `alembic upgrade head` = **0003 (head)**.
- Probe rows removed: **0** `qa-%@example.com` users remain, **0** probe profiles for U0/UP. (Pytest's teardown to base dropped the tables containing the probe rows; the post-restore backfill ran against an empty `users` table, so no probe residue.)
- Seed sanity: system category count = **18**.
- Temp files `/tmp/seed_ids_run1.txt` and `/tmp/seed_ids_run2.txt` removed.

**Overall**: ✅ **READY FOR REVIEW** — Section A green (31/31) AND Section B has 0 hard failures (31/31).
