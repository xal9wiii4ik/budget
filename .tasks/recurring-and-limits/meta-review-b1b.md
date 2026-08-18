# Meta-review: B1b (senior-lead over review-b1b.md)

## Rulings on findings

1. **AGREE (major).** The probe session sat outside the try, so `materialize_due`
   could raise on a dead DB — falsifying the D5 "never raises" docstring AND the
   app.py rationale for the unconditional boot run (the fx branch guards the
   identical scenario). Reviewer probe-verified the escape. FIXED: probe wrapped
   in broad except → warn + return, plus the mandated test
   `TestNeverRaises::test_unreachable_database_is_warned_not_raised` (caplog pins
   exactly one warning — separates "handled" from "silently lost"). Genuinely
   breakable, previously uncovered, breaks-today → clears the test doctrine.
2. **AGREE (major).** B1b-10 passed with the `tpl is None` branch deleted (the
   AttributeError vanished into the per-template except; reviewer mutation-proved
   it). FIXED: caplog asserts no "recurring materialization failed" record.
   Kill re-verified in the fix round: mutation → FAILED.
3. **AGREE (major).** B1b-9 pinned rollback but not loop continuation (a `break`
   in the handler passed both arms — the sole survivor committed before the
   fault). FIXED: third template created AFTER the failing one, asserted
   committed; in-test note on the unordered probe → survivor on each side.
   Kill re-verified: `break` mutation → both arms FAILED.
4. **AGREE (minor).** `_due_template_ids` docstring overstated the ended-template
   clause (it drops a template only when `end_date` lands on a due date; one
   ended between due dates stays a candidate forever, correctly producing
   nothing). Docstring corrected; behaviour untouched. NOTE: plan.md's own
   "keeps forever-ended rows out of the loop for free" line carries the same
   overstatement — recorded as noise, R9-style; no plan rewrite.
5. **AGREE (minor).** "ONE conversion site codebase-wide" was false (fx preview,
   goal_reads, tx_totals pair lookup_rate+convert_minor). Both docstrings now
   claim the true thing: the one snapshot-WRITE conversion site.
6. **DEFER (nit).** Cap warning fires on `len(dates) == MAX_OCCURRENCES`, so an
   exactly-366-due batch logs a spurious "capped". Matches the plan's specified
   line; cost is one wrong warning in an astronomically narrow case. Re-arm if
   the log line ever drives behaviour.
7. **DEFER (nit).** Both recurring jobs share one `recurring_kwargs` dict, so
   AM-6's per-job kwargs loop inspects one object twice. Divergence is
   impossible by construction (one dict, one site); the assertion still pins
   the absence of a bound `today`.
8. **DEFER (nit).** The lock-phase `tpl.paused` re-check arm is untested. The
   branch line is shared with the deleted arm (now caplog-hardened by F2), the
   outcome is a benign skip, and pause-transition semantics get their own pins
   at B2 (AM-7/GAP-7). Not worth a mirrored test today.

## Senior diff-gate notes (pre-review, for the record)

- Extraction verified byte-identical (executable body) against
  `git show HEAD:.../transactions.py`; router changes rename-only; the plan's
  "three call sites" was a miscount — two exist (create + the shared PATCH
  rows-5/6 site). Reviewer independently confirmed.
- fx lifespan branch is a pure re-indent under the OR-gate (behaviour preserved).
- AM-5 FOR UPDATE pin mutation-tested BY ME before review: lock deleted →
  concurrency test red (duplicate booking); restored byte-identical → green.
- Accepted engineer deviations (all in-file documented): B1b-10 seam injection
  (plan's mechanics were vacuous — the probe would never return a pre-deleted
  id); AM-5 barrier rendezvous (bare gather serializes on connection setup and
  pins nothing — engineer mutation-proved); job-fixture duplication per plan.

## Gate trail (all senior-re-run post-fix, authoritative)

- `uv run pytest` on PG 5443 (TEST_DATABASE_URL): **296 passed**
  (276 pre-B1b → +19 implement → +1 fix round).
- `ruff check` / `ruff format --check` / `pyright` strict: all clean.
- `pnpm openapi` → `git status --porcelain` on openapi.json + schema.d.ts:
  **empty** (O-1 zero-diff arm). `tests/test_transactions.py`: untouched (O-6).
- O-3: recurring gate forced False at all four app-construction sites +
  test_scheduler_wiring as the sole OQ-2 exception (engineer grep, senior
  spot-verified in diff). O-5 no new index. O-7 pinned by B1b-8/9. O-9/O-10:
  recurring_jobs.py imports no provider/anthropic/http; sole profile access is
  read_base_currency (verified in my read of the full file).
- QA per 2026-08-18 cadence: **STOP-PROBE only** (B1b = first scheduler
  integration boundary). 4/4 PASS on port 8011 (8010 held by a foreign pid,
  never touched): flag-off inertness; boot run-now materialized the exact
  hand-computed window once (RUB-on-RUB → NULL/NULL snapshot); cron fired and
  was a no-op under a real in-job `today`; CFG-C cleanup clean, exchange_rates
  byte-equal, repo tree byte-identical. TC-B1b-10/O-11 marked covered
  [stop-probe]; TC-B1b-1..9 stay pending for the scope-end full run.

**B1b verdict: ACCEPTED — ready for PM commit.**
