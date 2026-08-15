# Meta-Review (senior-lead): S3 — tx-snapshot-and-aggregates

Reviewer verdict: APPROVE WITH FIXES (1 MINOR, 2 NITs). My rulings:

- **Finding 1 (fold-in merge into an existing SQL bucket unpinned,
  tx_totals.py:113) — AGREE, fix required.** Independently verified against the
  fixture: no (category, kind) group mixed a non-NULL SQL total with a
  convertible bucket-3 row, so the overwrite regression
  (`by_bucket[bucket] = converted`) — a silent month understatement, exactly
  D9's failure class — passed the whole suite. This is the same non-vacuous-arm
  standard AM-3 enforces; a MUST-close for a FULL money-math subtask.

- **Finding 2 (`unconverted_count` accumulation only asserted at 1) — AGREE,
  folded into the same fix.** `= 1` vs `+= 1` is genuinely breakable and the
  pin rides Finding 1's fixture edit for free.

- **Finding 3 (no upper bound on `base_amount_minor` override) — AGREE with the
  deferral, no change.** Exactly mirrors the pre-existing accepted
  `amount_minor` contract (`ge`-only); fixing one side alone would be
  inconsistency, not hardening. **Carry-forward:** a joint upper-bound pass on
  `amount_minor` + `base_amount_minor` (+ goals `target_minor` when S5 lands).

## Fix round

Executed by backend-engineer, TEST-ONLY (verified: production file diffs
byte-identical before/after): test 14 gains (e) base-RUB income 2000 in cat_a
(merge arm → 52000 asserted; overwrite would yield 50000) and (f) a second
rateless KRW row (`unconverted_count == 2`); income 52000 / expense 13345 /
net 38655 recomputed with hand-pinned comments. Engineer ran a mutation probe
(both injected regressions fail the test; restored file passes). Gates re-run
after fix: pytest 151 passed, ruff check/format clean, pyright 0 errors.

## Verification trail

- My diff gate (pre-QA): single conversion site (`_auto_snapshot` →
  `lookup_rate` + `convert_minor`; zero Decimal math in router/tx_totals);
  override precedence (row 4 beats 5/6 in the elif chain, create elif order);
  PATCH table 1:1 with the plan's 7 rows (rows 5/6 legitimately share the
  identical recompute outcome, both separately tested); row-3 guard
  pre-mutation against eff_cur with a stored-state no-half-apply assertion;
  CASE arm order = stale-base bypass; mixed bucket-1/2+3 groups merge
  correctly; by_category ordering parity; no-oracle intact (all new guards
  after `_load_own`); contract pair additive and regenerated together
  (SummaryRead.unconverted_count REQUIRED, read pair required-but-nullable).
  Gates re-run by me: pytest 151 passed, ruff clean, pyright 0.
- QA (TC-S3-1..6 + TC-Z1): 7/7, no STOP. Highlights: create snapshot ==
  /fx/convert diff 0 on two pairs (one conversion implementation, live);
  AM-3a live in both arms (pre-history date AND unrated currency → NULL/NULL,
  never 500); summary before/after-rate delta exactly +500000; live openapi
  deep-equals committed. Rates table left canonical-only (2282 rows) for
  S4/S5.

## Accepted deviations (recorded)

- Plan test 16 folded into the existing all-base summary test (one
  `unconverted_count == 0` assertion) — a separate test would duplicate the
  fixture.
- Create: currency OMITTED + `base_amount_minor` sent → same 422
  `BASE_AMOUNT_WITHOUT_CURRENCY` as explicit base currency (the row resolves to
  base either way); byte-pinned in test 4.
- PATCH now calls `_get_or_create_profile` (plan-directed: base resolved at
  PATCH time); self-heal commits atomically with the edit, rolls back on 422.
- QA wording: no `GET /transactions/{id}` route exists (pre-existing surface);
  TC-S3-1/2/3 read-backs used the list endpoint.

## Carry-forward rows ticked (grooming-review §4)

- AM-3a recompute-to-miss arm (test 7) — ✅ (pytest third arm + TC-S3-3 live,
  both the pre-history-date and unrated-currency variants).
- AM-3b stale-base+no-rate arm (test 15) — ✅ (stale 777 never reused; excluded
  + counted; contrasts the converted 80000 row).
- Contract regen+commit together — regenerated together in this tree ✅; the
  single S3 commit must include both artifacts (PM commit step).
- Web ripple handoff: after S3's commit, plan-web W1 consumes the regenerated
  schema.d.ts (`unconverted_count` REQUIRED; nullable `base_currency` must
  never decode at a guessed exponent — AM-5).
