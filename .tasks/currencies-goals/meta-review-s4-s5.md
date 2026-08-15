# Meta-Review (senior-lead): S4 goals-domain + S5 goals-api (combined pass)

Reviewer verdict: REQUEST CHANGES (1 BLOCKER, 3 MINOR, 3 NIT) — review-s4-s5.md.
My rulings:

- **F1 (BLOCKER — `suggested_deadline` date overflow → deterministic 500 on the
  whole /goals read surface) — AGREE.** Independently verified the arithmetic:
  `months_to_target(100_000, 0, 1) = 100_000` months → year 10359 > MAXYEAR.
  A near-break-even user (1-minor surplus) bricks their goals screen — exactly
  the never-500 stance violation. Fixed domain-side: `suggested_deadline ->
  date | None`, year-guard before `date()` construction. **This amends the
  D11-verbatim signature — recorded deviation** (wire field was already
  nullable; contract artifacts unchanged, drift test green without regen).
- **F2 (archived-goal waterfall exclusion unpinned) — AGREE, fix required.**
  Same non-vacuous-arm standard as S3 meta-review F1: the dropped-guard
  mutation passed all 188 tests and its failure mode is the AM-4 class.
- **F3 (contributions list zero coverage) — AGREE, fix required.** Fresh money
  surface; reversed ORDER BY passed the suite; W4 depends on the ordering.
  Plan gap (S5 test list omitted it), not an engineer omission.
- **F4 (progress unbounded right edge) — PARTIALLY AGREE.** The card-vs-chart
  mismatch is real, but the proposed WHERE bound changes no observable
  behavior (emit loop already ignored future keys) — accepted as intent
  hygiene only. The substantive questions are NOT S5 code changes:
  **carry-forward (a)** future-dated-contribution policy (allow-and-render vs
  reject) → PM/product; **carry-forward (b)** plan-web W4: chart must
  reconcile with `saved_minor` per (a) and tolerate negative `saved_end_minor`
  (past-dated withdrawal can dip intermediate points below 0).
- **F5 (bare `next()` race → 500) — AGREE.** One line, resolves to the
  no-oracle 404.
- **F6 (`_TODAY` frozen at test-module import) — AGREE with recording, no
  change.** Once-a-month-at-midnight CI curiosity; review-s4-s5.md is the
  triage record.
- **F7 (falsy-`or` priority default) — AGREE.** Clarity only, no behavior change.

## Fix round

Executed by backend-engineer: F1 (domain guard + contrasting test (v)),
F2/F3 (test arms), F4/F5/F7 (three one-liners). Mutation probes run and
reported: dropped-archived-guard and reversed-ORDER-BY each fail their new
test, restored code passes. Gates after fix: **pytest 190 passed** (188 + 2),
ruff check/format clean, pyright 0 errors, openapi drift green WITHOUT regen
(contract untouched by the fix round). I re-verified the diff: domain guard
placement (before `date()`, after divmod), 404 raise on the `next` miss,
upper-bound WHERE, priority expression.

## Verification trail

- **S4 diff gate (pre-QA):** signatures grep-verified verbatim vs D11;
  4 plan resolutions present (single `//` on difference-of-sums, `needed<=0`
  short-circuit, sequential min-waterfall, `-(-a//b)` ceil); purity (stdlib
  only, no float, no quantization); all (a)–(u) arms present, (h)/(l)/(s)
  pins read line-by-line. Gates re-run by me: 172 passed, ruff/format/pyright
  clean. QA S4: TC-Z1 only per checklist — 172 passed.
- **S5 diff gate (pre-QA):** single-source math held (router/assembler calls
  only domain/goals + domain/fx via fx_lookup; `_shift_month` is date-only);
  no-oracle single code paths both walls; FOR-UPDATE on both contribution
  writes, exactly-to-zero boundaries; D-List two-level flags; AM-4 field on
  both shapes + list/single consistency over a 3-goal fixture (G5 closed);
  archived-inclusion in `_single_goal_read` proven allocation-neutral;
  openapi delta python-deep-compared: purely additive (5 paths, 9 schemas,
  zero changes to existing surface — the 772-line churn was serialization
  noise). Gates re-run by me: 188 passed + drift green.
- **QA S5 (TC-S5-1..6 + TC-Z1):** 7/7, no STOP. Hand-pins exact (free
  3000000, needed/allocated 2500000, suggested 2026-12-15); no-oracle wire
  bytes diff-empty; [SL-3] isolated degradation on real rates; live openapi
  deep-equals committed; rates table left canonical 2282 rows; zero external
  HTTP (P3).
- **Reviewer's positive verifications** (rate directions both ways, FOR-UPDATE
  serialization under READ COMMITTED, contract honesty) — read and concurred.

## Accepted deviations (recorded)

1. `deadline=None` goal → `monthly_needed_minor=0`, `realistic=true`, zero
   waterfall need (plan/D11 silent; flagged to plan-web W3 rendering).
2. POST/PATCH /goals respond with the assembled `GoalRead`.
3. `clean_note` made public in schemas/transaction.py (mandated reuse).
4. `suggested_deadline -> date | None` (F1 — D11 signature amendment).
5. Free-balance window = 3 `converted_totals` calls (empty months are 0).

## Carry-forward rows ticked (grooming-review §4)

- AM-4 base_currency field + list/single consistency test — ✅ (pytest 3-goal
  fixture + archived arm + TC-S5-3/G5 live).
- Contract regen+commit together — regenerated together in-tree ✅; the S5
  commit must include openapi.json + schema.d.ts (PM commit step).
- New carry-forwards: F4(a) future-dated contribution policy → PM;
  F4(b) chart reconciliation + negative-Y → plan-web W4; joint upper-bound
  pass (`amount_minor`/`base_amount_minor`/`target_minor`) still open from S3.
