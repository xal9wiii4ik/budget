# Meta-review — B1 (stats aggregates API)

Senior-lead verdicts on review-b1.md findings, plus the run's recorded deviations.

## Reviewer findings

- **Finding 1 (MINOR, pre-auth 422 ordering): AGREE — fixed.** The qa-checklist's TC-B1-1
  itself frames pre-auth grammar exposure as the concern ("the wall fires before
  validation"), and QA's probe (`period=nonsense`) only exercised the accumulated-validation
  path, so both nets missed the resolver's raised-422 path. Practical leak value is ~zero
  (openapi.json is public), but the inconsistency was real and the same landmine is already
  documented for B2b's advisor route — fixing here keeps one rule. Fix round 2: auth-first
  reorder in both handlers, load-bearing comment, new non-vacuous arm
  `test_stats_requires_auth[summary-anchorless]` (verified to fail against the old
  ordering). `pnpm openapi` → zero contract diff, full gates green (227 passed).
- **Finding 2 (NIT, write-only `ResolvedPeriod.unit`): PARTIALLY AGREE — kept.** It is
  write-only today, but it is the plan's specified dataclass shape and B2b/B3 period
  consumers may read it; removing and re-adding is churn. Recorded, not changed.
- **Finding 3 (NIT, missing status asserts in scoping test): AGREE — fixed** in round 2.

## Deviations accepted at my diff gate (recorded)

1. **401 responses arm on /stats routes** — truthful (routes answer
   `{"detail":"Unauthorized"}`), and the only way to anchor `StatsError` as a named
   component without declaring an arm no route can emit (stats has no 404). Additive for
   clients; QA verified the artifact shape. Accepted.
2. **tx_totals private helpers** — the single-definition CASE/predicate beats three copies
   of load-bearing arm order; reviewer verified behaviour-identity; shipped suites
   unmodified. Accepted.
3. **Year envelope 1970–2999 (fix round 1, my finding).** My diff gate found 500s on
   syntactically valid anchors near date.max (`month=9999-12`, `quarter=9999-Q4`,
   `custom&to=9999-12-31`; plus the engineer's own find `custom&from=0001-01-01` → underflow).
   `month=9999-12` was a PRE-EXISTING 500 on shipped /transactions/summary — the shared
   MONTH_PATTERN narrowing cures it too (deliberate 500→422 contract narrowing, recorded).
   Custom bounds via `Annotated[date, Field(ge/le)]` (FastAPI's Query(ge/le) stubs are
   number-typed; Pydantic enforces identically). The date bounds are invisible in JSON
   Schema — same invisibility class as regex semantics; the 422 arm is declared. Accepted.
4. **AM-3 as its own test** (byte-identity arm can't share the 422 parametrize signature) —
   accepted, the pin is stronger than the plan's placement.

## Carry-forwards / notes for later subtasks

- QA note: TC-B1-6's `contribution = -MAX → 201` arm needs the goal pre-funded
  (CONTRIBUTION_EXCEEDS_SAVED otherwise) — checklist should say "fund the goal first".
- `initial_saved_minor` carries `minimum: 1` (0 rejected) — pre-existing shipped shape,
  observed by QA, no action.
- `packages/api-client/src/patch.test.ts` has an uncommitted 16-line diff belonging to the
  PARALLEL receipts S5/S6 web pipeline — it must NOT be included in B1's commit.
- B2b inherits the auth-first parameter-order rule with a shipped precedent + pinned test
  pattern to copy.

## Obligations discharged (evidence in the /implement report, summarized)

- O-1: EXPLAIN ANALYZE over 5k-row user — Bitmap Index Scan on
  `ix_transactions_user_id_occurred_at` (full composite range in Index Cond), in-memory
  HashAggregate (Batches: 1), 0.68 ms. Discharged.
- O-2: dev-DB max() pre-flight — all maxima ≥5 orders of magnitude below MAX_MINOR_AMOUNT
  (max tx 18,000,000; max goal 500,000,000; contributions −500,000..2,000,000). Bounds safe.
- O-3: expense-only pin — `test_top_merchants_are_expense_only` (5M income SalaryCo absent).
- [SL-1]: schema.d.ts renders literal `PeriodBounds: { from: string; to: string }`.

## Final state

QA: 8/8 live TCs green (TC-Z1 + TC-B1-1..7), fixture-F pins exact, zero 5xx, cleanup done.
Gates after round 2: pytest 227 passed, ruff clean, pyright 0, api-client typecheck/test
green, contract pair regenerated together. B1 is DONE pending PM commit.
