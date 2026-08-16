# Code Review — B1 (stats aggregates API), tier FULL

Reviewer: code-reviewer (general-purpose agent), over the uncommitted B1 working-tree diff.
Diff scope: apps/api (new: domain/periods.py, services/profile_reads.py, schemas/stats.py,
routers/stats.py, tests/test_periods.py, tests/test_stats.py; modified: services/tx_totals.py,
routers/transactions.py, routers/goals.py, schemas/transaction.py, schemas/goal.py, app.py,
tests/test_transactions.py, tests/test_goals_api.py) + regenerated openapi.json / schema.d.ts.
Excluded: packages/api-client/src/patch.test.ts (parallel receipts-web pipeline diff).

Pre-accepted deviations (senior-lead diff gate; verified sound by reviewer):
(1) 401 responses arm ($ref StatsError) on all three /stats routes — anchors the StatsError
component (stats has no 404). (2) tx_totals private helpers `_effective_base_minor` /
`_bucket_three_rows`, converted_totals rewired behaviour-identically. (3) Fix-round year
envelope 1970–2999 on all four period grammars (incl. shipped /transactions/summary — a
deliberate 500→422 narrowing); custom from/to bounded via `Annotated[date, Field(ge/le)]`
(contract-invisible, accepted). (4) previous_period degenerate-window clamps.

## Findings

1. **MINOR — routers/stats.py — business 422 pre-empts 401 for unauthenticated requests.**
   `period: ResolvedPeriod = Depends(resolve_period)` was declared before
   `user: User = Depends(current_active_user)`; `resolve_period` raises its own
   HTTPException(422, PERIOD_ANCHOR_REQUIRED), so an unauthenticated anchorless request
   answered 422 while a malformed-anchor request answered 401 (param-validation errors
   accumulate; auth raises first). Empirically verified. Fix: reorder auth first in both
   period-scoped handlers + a pinning test arm.
2. **NIT — routers/stats.py — `ResolvedPeriod.unit` is write-only** (no consumer reads it
   after `resolve_period` calls `previous_period` internally).
3. **NIT — tests/test_stats.py::test_stats_scoped_to_user** asserts `.json()` without first
   asserting status codes.

## Clean categories (verified, one line each)

- Money math: minor units end-to-end; CASE arm order (currency==base first) preserved;
  exclude-and-flag correct in all three functions; COUNT(effective)/SUM(effective) describe
  the same row set (DB CHECK guarantees snapshot-pair integrity); signed net pinned at an
  exact negative value.
- converted_totals rewiring: behaviour-identical; both shipped suites pass unmodified.
- Auth/scoping: every new query filters user_id; B1-14 scoping test present.
- Calendar math: leap-Feb, Q4-across-year, calendar-previous vs fixed-length, custom
  same-length previous, inverted/absurd-window clamps all pinned; no timezone hazard
  (occurred_at is Date; both _today()s UTC).
- SQL efficiency: one grouped pass + one bucket-3 scan per function; deterministic tiebreak;
  limit cut after fold-in.
- Contract honesty: 422 anyOf union on the two period routes only; monthly = bare
  HTTPValidationError; literal `from` key; D14 maxima in both artifacts; no hand-edits.
- Tests: no vacuous tests; AM-1/AM-2/AM-3 genuinely folded; accept-at-max contrast arms on
  all D14 tests incl. both contribution signs.
- Layering: domain stdlib-only; services never import routers; router computes no math.

## Verdict

**APPROVE-WITH-NITS** — one functional MINOR (finding 1), two NITs; nothing blocking on
money math, scoping, calendar semantics, or the contract.
