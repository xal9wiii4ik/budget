# Code Review: B1a — migration 0006 + models + domain/recurrence (tier FULL)

Reviewer: general-purpose code-reviewer, /review_senior stage, 2026-08-18.
Briefed per PM policy 2026-08-17: code review only, no gate re-runs (senior-lead's
independent gate run authoritative), targeted probes allowed (two python probes run).

## Findings

1. **MAJOR (test-coverage)** — `tests/test_recurrence.py`: the clamp × strictly-after
   interaction unpinned. Every monthly `next_due`/`due_dates_between` arm used
   dom=15/dom=1 (never-clamping days). Probe evidence: a plausible buggy
   implementation comparing the raw anchor (`day_of_month > after.day`) passes all
   existing arms while returning Feb 28 for `after=Feb 28, dom=31` — watermark-equal,
   which in `due_dates_between` yields 366 duplicate Feb 28 rows per job run.
   Production code confirmed CORRECT by probe (clamped-watermark resume Feb 28 → Mar 31;
   dom=31 walk Jan→Apr clean; leap resume 2028-02-29 → 2028-03-31). Fix: one `next_due`
   arm + one dom=31 `due_dates_between` walk spanning February.
2. **NIT (doc)** — migration 0006 docstring: "the two composite PKs" is wrong;
   recurring_templates has a plain `id` PK, only category_limits is composite.
3. **NIT (defensive shape)** — `domain/recurrence.py`: the weekly branch is the
   implicit else for any non-month unit; a third RecurrenceUnit would silently be
   treated as weekly. Acceptable as-is (D3 pins two units).

## Explicitly clear

- Recurrence correctness: no defects (strictly-after both units, divmod rollover
  probed at Nov/Dec/year boundary, clamp never skips or duplicates, cap resumable,
  ValueError preconditions match the DB CHECK, module pure).
- Migration ↔ models: column-for-column parity; all names match NAMING_CONVENTION
  + 0005 op.f() style; downgrade fully symmetric and correctly ordered
  (`downgrade base` safe).
- Test quality otherwise strong: every planned contrast arm real; AM-1 fixture
  genuinely cap-exercising (420 Mondays = 366 + 54, third-run-empty, 4-week contrast).
- Later-subtask tripwires: none (clamped-watermark resume safe for B1b;
  `last_materialized_on` NOT NULL no-default correctly deferred to B2's create path).

**Verdict: approve with one test to add (finding 1). No blockers; production code
correct as written.**
