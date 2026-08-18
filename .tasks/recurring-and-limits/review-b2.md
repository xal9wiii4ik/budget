# Code review: B2 — /recurring CRUD + tx attribution (code-reviewer, 2026-08-18)

Reviewed the uncommitted B2 diff vs HEAD 5121656 per the 2026-08-17 briefing rule
(code only; targeted probes; senior's gate re-run authoritative).

**Verdict: the code is correct. No major findings.**

## Verified (evidence in reviewer log)
1. PATCH effective-pair logic: every unit/anchor combination traced — no
   half-apply, no silent discard (except finding 1's unpinned mirror), no path
   reaches the DB CHECK as a 500; all raises precede ORM mutation.
2. SL-A ordering sound (`template.paused` read before assignment). Mutation
   probes: transition-blind unpause, bare `= today−1`, dropped floor — each
   killed by its named test (AM-7 / B2-9 / B2-7+AM-9). Baseline re-green.
3. next_due_on = first due on or after today; end_date inclusive, matches the
   job's `through` clamp; `_today()` once per request.
4. Auth/no-oracle: `_load_own` user-scoped one-404-path (byte-identical bodies
   pinned); list user-filtered; category refs via load_visible_category with
   foreign-archived→NOT_FOUND ordering.
5. Contract honesty: anyOf 422 union real on both arms; DELETE's 422 = the
   /goals precedent (path-UUID validation); `last_materialized_on` nowhere in
   the spec; schema.d.ts sane (TransactionRead.recurring_template_id required
   `string | null`, absent from write DTOs; RecurringTemplateRead 15 required
   fields, `next_due_on: string | null`).
6. Test quality: SL pins kill their mutants; accept contrasts present; AM-7/8/9
   each present and non-vacuous.
7. Docstrings truthful except the count nit (finding 2).
8. Renames complete, no drift, import graph acyclic (recurring → goal/
   transaction schemas, nothing imports back).

## Findings
1. **[minor]** `test_patch_unit_switch_rules` pins only the month-branch
   ANCHOR_MISMATCH and week-branch ANCHOR_REQUIRED; mirror arms unpinned —
   deleting the week-branch mismatch check silently discards a client-sent
   `day_of_month` (the R1(5) failure) with the suite green. Fix: two arms —
   weekly + `{"day_of_month": 10}` → 422 ANCHOR_MISMATCH; weekly +
   `{"interval_unit": "month", "day_of_month": 5}` → 200, weekday cleared.
2. **[nit]** Test module docstring says "four tests call materialize_due"; six do.
3. **[nit]** `_TODAY` frozen at import vs live router clock: a suite run
   straddling UTC midnight flakes. Inherent to the plan's relative dating;
   recorded so a 00:00-UTC CI flake isn't misdiagnosed. No fix.

Working tree verified byte-identical after all mutation probes.
