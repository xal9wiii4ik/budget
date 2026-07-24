# Grooming Review (Phase 4) — core-data-model (roadmap 1.2)

Senior-lead critical review of architecture.md (architect, accepted at my gate
with two load-bearing claims spot-verified in code), plan.md (backend, 9 areas),
qa-checklist.md (qa-engineer, 31 command checks). Verdict: **accepted with the
rulings and amendments below.** No artifact goes back for rewrite; the deltas
fold at /implement (plan) and before /test (checklist).

## 1. Team selection (recorded)

architect (three new tables, seed shipping strategy, and the sign-convention
question — squarely structural) + backend-engineer (all apps/api changes plus
the turbo.json root-file line, ownership per carry-forward (c)) + qa-engineer
(no endpoints → QA reshaped from curl to live DB/migration-CLI verification,
justified in the checklist's Scope section and endorsed here). NOT invoked:
frontend-engineer / mobile-engineer / web-qa / mobile-qa — no client code, no
UI, and **the OpenAPI contract does not change in this task** (a verified
claim, not an assumption: no `schemas/`/`routers/` edits; gated by the existing
`test_openapi_export` pytest plus QA TC-O1's byte-identical git check against
pre-task HEAD 19f4e36). code-reviewer arrives at /review_senior.

Process note: architect's two load-bearing "verified" claims were re-verified
by me directly before acceptance (auth.py:55 `self._session` capture +
:104-108 commit pattern; conftest.py:118 table-level TRUNCATE landmine). Both
held. Backend and QA then worked in parallel — safe here because QA's oracle
is the accepted architecture (constraints/cascades/seed/backfill), not plan
mechanics.

## 2. THE design question — sign convention (verified resolved, not buried)

The task brief demanded this not ship implicit. Verdict trail, checked across
all three artifacts:

- **architecture §1** decomposes three options and rules **(b): amount_minor
  stays a non-negative magnitude (CHECK >= 0); a NOT NULL `kind`
  ('expense'|'income', CHECK) lives ON the transaction row.** For an
  uncategorized transaction the sign lives in its own `kind` column — never
  derived from the (nullable) category. Refunds = income-kind rows against
  expense categories; category `kind` is prefill/default only; transaction
  `kind` is the aggregation source of truth. Signed storage (a) was rejected
  because it contradicts the verified shared contract (`parseMoney` rejects
  negatives, `toInputString` throws) and makes re-categorization a write-time
  sign-flip; derived-kind (c) was named a buried default and rejected.
- **plan** implements it exactly: `transaction.py` kind column + the three
  CHECKs; the highest-value test
  `test_category_delete_sets_null_and_kind_survives` pins the design contrast
  (category gone → category_id NULL, kind and amount intact).
- **qa-checklist** proves it live: TC-C4 (kind CHECK rejects 'transfer'),
  TC-C6 (kind NOT NULL), TC-X2 (SET NULL with kind/amount unchanged —
  explicitly called out as THE §1 contrast).

Consistent in all three layers; the two decisions (`kind` on transactions,
`category_id ON DELETE SET NULL`) reinforce each other by design. The one
PM-vetoable residue is surfaced as open question 2 (tx.kind independent of
category.kind — refunds expressible — vs a hard match rule). SET-NULL survives
into §6's cascade table with the reasoning recorded. **Resolved, consistent,
not buried.**

Forcings on 1.3/1.4 are recorded in architecture §1 (required `kind` in
transaction schemas, CASE-expression summary SQL, cross-kind re-categorization
UX ownership, cross-user category authorization + system-category mutation
guards at API level per §6) — 1.3/1.4 groomings MUST read them.

## 3. Rulings on the PM's seams + my own findings

### R1 — Inferred CHECK names (QA's caveat). RULED: pinned, binding.

plan.md's model skeletons already derive them mechanically from the naming
convention (`ck_%(table_name)s_%(constraint_name)s` with the `name=` suffix
spelled per constraint). The full six-name set is now the **binding contract**
for migration 0002 and every error-message assertion:

```
ck_categories_kind_valid
ck_profiles_base_currency_format
ck_profiles_monthly_income_minor_non_negative
ck_transactions_amount_minor_non_negative
ck_transactions_currency_format
ck_transactions_kind_valid
```

QA's TC-C3/TC-C5 expectations were already right; the Area C
"verify they match" caveat note is **deleted** (AM-1). TC-G1's expected list is
unchanged and is the catalog-level pin.

### R2a — Backend's CHECK-twin test trim. RULED: ACCEPT, with the contingency written down.

Backend tests each CHECK *class* once on `transactions` (>= 0, kind IN,
currency regex) and excludes the structurally identical twins
(`profiles.monthly_income_minor >= 0`, `profiles.base_currency` regex,
`categories.kind_valid`). Correct application of the no-redundant-tests
policy — pytest re-asserting an identical SQL branch adds nothing. The
residual risk backend flagged (a typo in one migration CHECK line but not its
twin) is **not actually residual**: QA's live layer probes exactly the
excluded twins (TC-C1, TC-C2, TC-C7) and TC-G1 asserts all six names exist.
Acceptance is therefore **contingent on Area C + TC-G1 staying in the /test
run** — the twins' only enforcement proof is live. Recorded as AM-2; if a
future grooming ever trims Area C, the twins must gain pytest first.

### R2b — Backend's subprocess backfill test (downgrade 0002 → insert → upgrade 0003). RULED: REJECT the permanent pytest; QA TC-M2/M3 is the designated gate.

This is my one substantive disagreement with the plan, reasoned:

- A migration file is **frozen once merged** — 0003 never runs again in a
  deployed environment and never changes (editing shipped migrations is
  already forbidden by convention). Run-once behavior warrants run-once
  verification, and QA TC-M2 provides it at **higher fidelity** than the
  proposed pytest: it stages the pre-existing user at revision **0001**
  (before `profiles` even exists — the true production scenario for our 1.1
  users), where the pytest could only stage at 0002.
- The pytest's cost is permanent and real — backend's own Risks section names
  it the top fragility: mid-suite schema cycling, cascade-fail of subsequent
  tests on a mid-cycle failure, try/finally scaffolding. Paying a forever-cost
  to guard a file that cannot regress fails the project's own test policy.
- Contrast with 1.1's AM-D (which DID CI-gate a fragile mechanism): route
  post-decoration is a *persistent runtime mechanism* any future change can
  silently break; a data migration is not. The distinction is principled, not
  ad hoc.

Consequences (AM-3): `tests/test_migrations.py` is dropped; plan's test count
8 → **7**; the carry-forward (a) checklist row re-points from the pytest to
**QA TC-M2/M3 (+ TC-M5–M7 for the downgrade path), which become a mandatory
merge gate** — /test cannot be skipped for this task, and the task brief's
"downgrade path tested" is satisfied by Area M live rather than pytest. QA's
Scope claim ("pytest structurally cannot see the backfill") stands. The
`test_register_creates_rub_profile` hook test (the go-forward mechanism, which
IS persistent runtime code) stays in pytest — that split is exactly right.
Veto point for the PM in §6.

### R3 — `alembic check` blind to CHECKs. CONFIRMED: Area C + TC-G1 is the accepted guard.

Correct and well-layered: TC-O2's green certifies the structural skeleton
(tables/columns/indexes/FKs); TC-G1 proves the six CHECK names exist in
`pg_constraint`; Area C proves they enforce; pytest pins the transactions
class continuously in CI. Four layers, no single point of blindness. The
checklist's caveat wording on TC-O2 is exactly right. (pg_constraint vs
pg_indexes catalog discipline — the 1.1 AM-J lesson — correctly applied
throughout Area G.)

### R4 — My finding: plan's autogenerate-comparison claim is stale. AM-4.

plan.md ("What the probe actually compares") asserts `compare_type=False` by
default. Wrong for our stack: **Alembic 1.18.5 is pinned (uv.lock) and
`compare_type` has defaulted to True since 1.12**; env.py:42 sets no override
(verified by me). The probe therefore DOES compare column types — strictly in
our favor (a BigInteger/Integer mismatch would be caught), and the plan's
conclusion (CHECKs still invisible, rows still invisible, pytest covers CHECK
enforcement) is unaffected. Amendment: fix the paragraph; `compare_server_default`
remains False by default — the server-default agreement between models and
0002 stays a hand-review item at my diff gate. Implement-time: no env.py
change needed or wanted.

### R5 — Minor artifact drifts (fold quietly)

- **QA Section A expectation list** names "model round-trips" and "migration
  up/down cycle" as expected pytest content — backend excluded round-trips
  (justified) and R2b removed the migration pytest. Section A's prose is
  replaced by a pointer to plan.md's actual 7-test list (AM-5). QA's job at
  /test is to run the suite green, not prescribe its contents.
- **Probe command duality**: plan's authoring workflow uses the manual
  `revision --autogenerate` + inspect + delete probe; the standing gate
  command is `alembic check` (TC-O2). Both are the same comparison; authoring
  uses the former, gates use the latter. Recorded, no change.
- **turbo.json `env` vs `passThroughEnv`**: the brief pinned
  `env: ["TEST_DATABASE_URL"]` and the plan complies. For the record, `env`
  is also the better choice on merit: the var participates in the cache key,
  so a changed DB target re-runs tests instead of serving a stale cache hit.

## 4. Amendments (binding)

- **AM-1** — Six CHECK constraint names pinned (§R1 list) as the migration
  contract; QA deletes the Area C inferred-name caveat.
- **AM-2** — CHECK-twin pytest trim accepted; contingency recorded: QA
  TC-C1/C2/C7 + TC-G1 are the twins' only enforcement proof and MUST run at
  /test.
- **AM-3** — `tests/test_migrations.py` rejected; 7 pytest tests total; QA
  TC-M2/M3 (backfill) + TC-M5–M7 (downgrade path, seed-UUID stability) become
  a mandatory merge gate; plan's carry-forward (a) row re-points accordingly.
- **AM-4** — Plan's autogenerate paragraph corrected: Alembic 1.18.5 compares
  types by default (probe stronger than stated); server defaults remain
  hand-review at my diff gate.
- **AM-5** — QA Section A prose replaced with a pointer to plan.md's final
  test list.

## 5. Per-carry-forward checklist (Phase 4 obligation)

| Binding item | Source | In plan.md | In qa-checklist.md | Verdict |
|---|---|---|---|---|
| (a) profiles backfill for pre-existing 1.1 users | auth §7 / task (a) | ✓ 0003 `INSERT…SELECT…ON CONFLICT DO NOTHING` (+ hook for go-forward) | ✓ TC-M2/M3 — **merge gate per AM-3** | covered |
| (b) `env: ["TEST_DATABASE_URL"]` on `@budget/api#test` | task (b) / 1.1 meta §4 | ✓ exact JSON edit | n/a (build config) | covered |
| (c) root-file ownership = backend-engineer | task (c) | ✓ turbo.json in backend's files-to-modify | n/a | covered |
| (d) per-amendment checklist in /implement report | task (d) | ✓ table present + obligation restated | ✓ summary gates | covered; /implement ticks AM-1…AM-5 + every plan-table row individually |
| (e) contract artifacts regenerate/commit together IF schema changes | task (e) | ✓ not triggered — no schemas/routers touched; `test_openapi_export` green | ✓ TC-O1 byte-identical vs 19f4e36 + worktree; TC-O2 | covered (not-triggered is itself verified) |
| (f) local PG 5443 via TEST_DATABASE_URL; committed 5433 foreign | task (f) | ✓ verification commands | ✓ preconditions table + TC-P1 STOP rule | covered |

## 6. Risky spots — my own verification (not delegated)

1. **Hook write path**: `self._session` capture + commit is the proven
   `_revoke_all_refresh_tokens` pattern (auth.py:55/104-108, read by me). The
   accepted failure mode (user committed, profile insert 500s) is recorded
   with its mitigation trigger (get-or-create at the first profile-reading
   task) — machinery deliberately not built (Phase 3.6).
2. **conftest `DELETE FROM users`**: correct against the ondelete graph — all
   four user-referencing FKs are CASCADE, so row-level delete clears
   profiles/categories/transactions/refresh_tokens while `user_id IS NULL`
   seeds survive; no orphan sources exist (all FKs NOT NULL or
   user-anchored). `RESTART IDENTITY` drop is right (UUID PKs only). The
   seed-count pytest fails loudly if this ever regresses.
3. **Seed UUID literals** are locked in plan.md's table (generated at plan
   time). Pinned three ways: pytest stable spot-check (`ce814749…` →
   Продукты), QA TC-M4/M7 rebuild-stability diff, and my diff gate comparing
   migration file against the plan table. 2.2/2.5 will cache these ids.
4. **Downgrade asymmetry** (0003 down keeps backfilled profiles) is a
   conscious, documented decision (architecture §9), live-verified by TC-M5 —
   not an oversight a later reader could mistake.
5. **`icon String(16)`** counts characters (PG varchar semantics); longest
   seed emoji is 3 code points. A longer future ZWJ sequence is a 1.3 concern,
   recorded.
6. **No ORM `relationship()`s** — cascade is DB-level only, matching
   refresh_token.py; nothing in this task navigates objects. Deliberate,
   recorded.

## 7. Carry-forwards to future tasks (durable record; each grooming reads this)

- **1.3 (categories API)**: system-category mutation guard (reject
  rename/icon/color/archive where `user_id IS NULL` — `archived` is global);
  one Python `StrEnum` for kind shared by models+schemas; color format
  validation (no DB CHECK); icon length policy; optional duplicate-name
  softness. Extraction rule: the visible-categories query
  (`user_id = :u OR user_id IS NULL`) is extracted by the SECOND consumer.
- **1.4 (transactions API)**: transaction schemas carry required `kind`
  (client defaults from category); summary SQL via the §1 CASE expression;
  zero-amount API policy; note length cap; cross-kind re-categorization UX;
  **cross-user category authorization on write paths (load category, require
  system-or-own) — MUST be pytest-covered there** (DB cannot express it);
  self-healing profile get-or-create on the first profile read.
- **2.1 (receipts)**: add `transactions.receipt_id Uuid NULL` + FK
  `ondelete=SET NULL` in the same migration that creates `receipts`
  (architecture §5 trigger).
- **2.5 / 4.1**: revisit `transactions.category_id` index if EXPLAIN shows it
  (recorded no-index verdict, §7).
- **Stage 5 (transfers)**: third `kind` value = one-line CHECK alter under the
  varchar+CHECK representation; no data rewrite.

## 8. Decisions made this grooming (PM may veto, no answer required)

Magnitude + NOT NULL `kind` on transactions (sign never derived, §2 above);
`category_id ON DELETE SET NULL`, all user_id FKs CASCADE; varchar+CHECK over
PG enum; hook auto-create + 0003 backfill with `RUB` and no server_default on
base_currency; 18-category seed as data migration 0003 with hardcoded UUIDs;
no `receipt_id` until 2.1; composite `(user_id, occurred_at)` index with
explicit name, `ix_categories_user_id`, and recorded no-index verdicts; no
repository/domain layer (extraction rule recorded); split 0002 DDL / 0003
data with documented downgrade asymmetry; conftest row-level cleanup; six
pinned CHECK names; backfill verified live at /test instead of a permanent
mid-suite pytest (R2b); turbo.json `env` line per brief.

## 9. Open questions for the PM (veto-style; defaults = recommendations, none blocking)

1. **Backfill/default base currency `RUB` or `USD`?** Recommend **RUB**
   (product language; one-line change either way).
2. **Transaction `kind` independent of category kind (refunds expressible) vs
   a hard tx.kind==category.kind rule?** Recommend **independent, no DB
   constraint** — enables refunds, survives SET NULL; 1.4 owns the UX. This is
   the PM's veto point on the sign-convention resolution.
3. **Seed set: full 13+5 list vs minimal 8?** Recommend **full** — removing a
   referenced system category later is harder than never wanting more; names/
   icons/colors freely editable, ids frozen.
4. **`receipt_id` omitted until 2.1 (recorded deviation from the architecture
   sketch) vs FK-less column now?** Recommend **omit** — nullable ADD COLUMN
   at 2.1 is free; an unconstrained UUID column is not.
5. **Zero-amount transactions allowed at DB (`>= 0`), API policy deferred to
   1.4, vs CHECK `> 0` now?** Recommend **allow at DB** — strictness is
   contract policy and the contract task is 1.4.
6. **Backfill guarded by mandatory live QA gate (TC-M2/M3) instead of a
   permanent subprocess pytest (my R2b ruling)?** Recommend **live gate** —
   run-once verification for a run-once frozen migration; veto = restore
   backend's test_migrations.py with its try/finally scaffolding and accepted
   mid-suite fragility.

No blocking questions. Ready for /implement on PM's go: backend implements
plan.md + AM-1…AM-5 (7 tests, no test_migrations.py); QA folds AM-1/AM-5
deltas before /test; Area M runs as a mandatory merge gate; /implement report
ticks §5 and the plan's binding table row by row.
