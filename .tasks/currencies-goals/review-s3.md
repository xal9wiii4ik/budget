# Code Review — S3 tx-snapshot-and-aggregates (tier FULL)

Reviewer: code-reviewer · HEAD 00f42e2 + working tree · 2026-08-15
Scope: `services/tx_totals.py` (new), `routers/transactions.py`, `schemas/transaction.py`,
`tests/test_transactions.py`, regen pair (`openapi.json` + `schema.d.ts`).

## Verdict: APPROVE WITH FIXES

One MINOR test-gap fix requested (unpinned money-math arm in the D9 fold-in); no
code changes required. Everything else checked line-by-line against the plan's
create table, the 7-row PATCH table, D9, AM-3a/b, and R1(1) — sound.

Gates run by the reviewer: `pytest tests/test_transactions.py` → 31 passed;
`ruff` + `pyright` on the four Python files → clean; `openapi_export` re-run and
diffed against committed `openapi.json` → byte-in-sync; `api-client
scripts/generate.mjs` re-run → reproduces the working-tree `schema.d.ts` exactly
(no drift beyond the reviewed 14-line diff).

## Findings

### 1. MINOR — fold-in merge into an existing SQL bucket is unpinned
`apps/api/src/budget_api/services/tx_totals.py:113`
(`by_bucket[bucket] = by_bucket.get(bucket, 0) + converted`) and
`apps/api/tests/test_transactions.py` (`test_summary_buckets_and_flag`, ~line 799).

In test 14's fixture no `(category_id, kind)` group contains BOTH a bucket-1/2
row (non-NULL SQL total) and a convertible bucket-3 row: (a) is cat_a/expense
bucket 1 alone, (b) is cat_b/expense bucket 2 alone, (c) is cat_a/income bucket 3
folding into an *empty* key, (d) is excluded. The stale-base test (15) likewise
folds into an empty uncategorized key. Consequence: the regression
`by_bucket[bucket] = converted` (overwrite instead of accumulate) — a silent
understatement of a month's totals, exactly the failure class D9 exists to
prevent — passes the entire suite. This is a money-summation arm with no
contrasting test, which the project's own non-vacuous-arms standard (AM-3
rationale, QA G2/G4) treats as a MUST-close for S3.

Fix: extend test 14's fixture with one base-currency row sharing (c)'s
(cat_a, income) bucket (e.g. income 2000 RUB in cat_a) and assert
`(cat_a, "income") == 52000` — the merge arm then contrasts overwrite,
and income_minor/net move accordingly. No production code change needed.

### 2. NIT — `unconverted_count` accumulation asserted only at 1
`apps/api/src/budget_api/services/tx_totals.py:109`. Both summary tests end with
`unconverted_count == 1`; the regression `unconverted_count = 1` (assignment
instead of `+= 1`) passes. A second rateless row in either fixture (e.g. added
alongside Finding 1's fixture edit) pins the accumulation for free. Not blocking
on its own — the field's presence/exclusion semantics are already contrastively
pinned.

### 3. NIT — `base_amount_minor` override has no upper bound
`apps/api/src/budget_api/schemas/transaction.py` (`TransactionCreate`/`Update`,
`ge=1` only). A payload override of 2^63 reaches the BIGINT column and 500s as a
DB error instead of a 422. This exactly mirrors the pre-existing, accepted
`amount_minor` contract (same `ge`-only shape), so it is consistency, not a new
defect class. Recorded so a future hardening pass catches both together.

## Verified correct (risky spots checked and found sound)

- **CASE arm order + bucket complement** (`tx_totals.py:71-74, 96-104`): arm 1
  (`currency == base`) precedes arm 2, so a post-base-change row
  `currency=EUR, base_currency=RUB` under base EUR uses its native amount — the
  D5 stale-snapshot bypass. The bucket-3 WHERE
  (`currency != base AND (base_currency IS NULL OR base_currency != base)`) is
  the exact set complement of the two CASE arms, including SQL NULL semantics:
  no row is double-counted and none can fall through both passes.
- **NULL-sum guard** (`tx_totals.py:89-90`): a group made only of bucket-3 rows
  sums to NULL and is skipped; the fold-in owns it. `int(total)` at the SQL
  boundary kills the NUMERIC/Decimal leak from `SUM(bigint)`; every by_bucket
  value, fold-in addend, and income/expense sum is int. No float anywhere.
- **Rate direction at both call sites**: `lookup_rate(currency, base)` returns
  to-per-one-from with `to = base`; `convert_minor(amount, currency, base, rate)`
  matches its contract. The fold-in converts the NATIVE amount, never the stale
  snapshot (test 15's 999999 fixture is non-vacuous against 80000). Rounding
  occurs exactly once, inside `convert_minor`'s single ROUND_HALF_UP quantize;
  the inverted-rate path (only RUB→USD seeded; all USD math rides `invert`) is
  the path production uses.
- **Create table** (`transactions.py:227-243`): all rows mapped —
  null/omitted → stamp base + NULL/NULL (test 5, byte-compatible with a rate
  present); explicit-base + override → 422 (test 4 pins explicit and omitted to
  the same body, the accepted deviation); foreign + override → stored as sent
  even rateless (test 3's contrast arm); foreign auto → `_auto_snapshot` with
  miss → NULL/NULL. `payload.currency or base` is safe: the `^[A-Z]{3}$` pattern
  makes empty-string unrepresentable.
- **PATCH table** (`transactions.py:405-471`): row 1 → CURRENCY_REQUIRED before
  anything else; row 3 checked against `eff_cur` pre-mutation (test 13 asserts
  the DB row is byte-unchanged — no half-apply); rows 2/4/5+6/7 map onto the
  if/elif chain exactly, with the accepted 5/6 shared branch. The snapshot block
  runs AFTER the field writes, so recompute reads
  `tx.amount_minor/currency/occurred_at` post-application — `eff_occurred_at`
  correctness is pinned by test 7's rate-boundary arm. Row 2 clears
  unconditionally on `eff_cur == base` (never a self-copy), which also
  harmlessly clears a seeded stale pair whose currency equals the new base —
  consistent with the CASE-arm-1 bypass, matching row 2's letter.
- **Omitted-vs-null fork** via `model_fields_set`: row 5 recompute (R1(1)
  discard-override) vs row 7 keep — tests 9/10 contrast 80000 vs 79000, both
  arms non-vacuous. AM-3a (recompute-to-miss, test 7 third arm → NULL/NULL) and
  AM-3b (stale-base + rateless row → excluded and counted, stale 777 never
  reused) both present and contrastive.
- **Atomicity / self-heal**: every 422 in create and PATCH raises before any
  mutation of `tx`; the single commit sits after the full decision block. The
  PATCH-time `_get_or_create_profile` only flushes — on a subsequent 422 the
  self-heal rolls back with the request; on success it commits atomically with
  the edit. The summary GET still reads the profile without creating one
  (read-only preserved), and reads it BEFORE aggregating so the totals currency
  and the aggregation base can never diverge.
- **Ordering parity**: `sorted(..., key=(kind, -total))` reproduces the pre-3.2
  `ORDER BY kind, total DESC` for the two kind values; totals are strictly
  positive ints so `-total` is exact.
- **No silent currency fallback**: the NULL/NULL pair invariant is held at every
  write site, backed by the model's `base_snapshot_pair` CHECK; the schema
  comments carry the AM-5 never-decode-at-a-guessed-exponent warning; `ge=1`
  (user override) vs the model's `>= 0` (auto snapshot can quantize to 0) is
  deliberate and documented on both sides.
- **Contract**: purely additive. `TransactionRead.base_amount_minor`/
  `base_currency` required-but-nullable, `SummaryRead.unconverted_count`
  required (per D9), write DTO fields optional with the `^[A-Z]{3}$` pattern —
  openapi.json and schema.d.ts both match the Pydantic source exactly; both
  regens independently reproduced by the reviewer.
- **Plan test coverage**: tests 1–15 all present under their plan names; test 16
  folded into the existing all-base summary test (accepted deviation) with
  `unconverted_count == 0` asserted.
