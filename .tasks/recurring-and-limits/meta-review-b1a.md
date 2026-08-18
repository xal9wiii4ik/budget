# Meta-review: B1a (senior-lead over review-b1a.md)

## Rulings on findings

1. **AGREE (major).** Independently traced the counter-example: the raw-anchor
   comparison bug passes every dom=15/dom=1 arm and stalls the cursor on a clamped
   watermark — the exact mass-duplication failure the strictly-after contract exists
   to prevent, on the path B1b's materializer consumes first. Genuinely-breakable,
   previously uncovered branch → test mandated per the test doctrine. FIXED in the
   fix round: `test_next_due_resumes_from_a_clamped_watermark` (with the
   one-day-earlier contrast arm) + `test_due_dates_between_walks_dom_31_across_february`.
   Engineer mutation-checked: with the buggy comparison substituted, exactly the two
   new tests fail, the other 18 pass; source restored byte-identical.
2. **AGREE (nit).** Docstring corrected; zero DDL bytes changed.
3. **PARTIALLY AGREE, deferred.** The hazard is real only if a third RecurrenceUnit
   lands (D3 forbids it; grooming carry-forward already records interval_count/RRULE
   as future re-arm). An unreachable trailing raise buys nothing today. Recorded here;
   re-arm when the enum grows.

## Fix-round verification (senior-run, authoritative)

- Full suite post-fix: 276 passed (was 274; +2 = the mandated arms). ruff check /
  format --check / pyright strict all clean (engineer run, spot-verified by me on
  the delta files).
- Migration delta confirmed docstring-only; contract artifacts still byte-untouched
  (`git status --porcelain` empty on openapi.json + schema.d.ts).

## Gate trail (all senior-re-run unless noted)

- alembic upgrade head → 0006; `alembic check` → no drift; downgrade -1 / upgrade
  head round-trip clean (budget_test, O-2).
- pytest 274→276 passed; ruff + format + pyright clean (O-4).
- `pnpm openapi` → zero diff on both artifacts (O-1 negative arm).
- AM-1 arithmetic independently verified (420 Mondays 2018-08-06..2026-08-17;
  366th = 2025-08-04; remainder 54).
- O-5: index inventory = pk_recurring_templates, ix_recurring_templates_user_id,
  pk_category_limits only; no index on transactions.recurring_template_id.
- QA TC-B1a-1..4 all PASS on port 8011 (8010 held by parallel simulator session);
  no STOP triggers; live DB left at 0006; cleanup clean (see qa-checklist.md).

**B1a verdict: ACCEPTED — ready for PM commit.**
