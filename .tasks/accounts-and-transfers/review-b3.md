# Review B3 — PATCH /recurring/{id} account move

Reviewer: code-reviewer. Scope: uncommitted working-tree diff, B3 files only
(`routers/recurring.py`, `schemas/recurring.py`, `test_recurring_api.py`,
`openapi.json`, `schema.d.ts`); the mobile files in the same tree are another
subtask's. Gates not re-run (orchestrator's run authoritative). Probes: one —
`pytest tests/test_recurring_api.py::TestPatchAccountMove` → 4 passed; the rest
resolved by reading.

**Verdict: 0 BLOCKER, 0 MAJOR, 1 MINOR, 0 NIT.** The load-bearing pieces — gate
order, no-oracle, atomic restamp, untouched watermark, contract pair — are all
correct. The one finding is test-shape, not behavior.

## Findings

### MINOR-1 — the "echo accepted" arm never contrasts eff_cur
`test_move_restamps_currency_from_the_target_account`, second PATCH. By the time
it sends `{account_id: usd, currency: "USD"}`, the template is ALREADY on the USD
account from the first PATCH — so `eff_cur == template.currency == "USD"` and the
arm passes identically under the exact bug it claims to contrast ("eff_cur wrongly
derived from the stored stamp"). Its comment ("the contrast to the stale-echo
test") overstates it: this is the named-but-never-exercised branch shape the
project's test policy flags. No coverage hole in practice — the stale-echo test
catches an `eff_cur = template.currency` regression from the other direction —
but the fix is one line: send the echo PATCH FIRST, on the still-RUB template
(`{account_id: usd, currency: "USD"}` → 200, currency USD). Then it genuinely
pins "a move may echo the TARGET's currency in the same request".

## Checked and clean (per focus point)

1. **Gate order matches plan-b3 exactly.** `_load_own` (404) → `_REQUIRED_FIELDS`
   loop → `_reject_transfer_kind` → anchor block (payload+stored, no new DB) →
   `_require_own_account` → `eff_cur` currency gate → category → writes → single
   commit. Every payload-only 422 (`*_REQUIRED`, transfer-kind, anchor) fires
   before the account lookup, so an inexpressible payload answers identically
   whatever `account_id` points at.
2. **No-oracle.** The move reuses the router's existing `_require_own_account`
   (recurring.py:182-200): `load_own_account` scopes by user_id, foreign == missing
   == one 404 `ACCOUNT_NOT_FOUND` code path, archived checked strictly after (a
   foreign archived account answers 404). Test asserts
   `foreign_resp.json() == missing_resp.json()` — the house pattern
   (test_accounts.py:254-255 does the same); detail strings identical, so
   JSON-equality is as strong as byte-equality here.
3. **Restamp exactly on move, never half.** `template.currency` is written ONLY
   inside `if account is not None:` (i.e. account_id in fields and validated),
   paired with `template.account_id` in the same block; the payload never reaches
   `currency` directly. "New account + old currency" dies at the `eff_cur` gate
   before any attribute write — single commit at the end, nothing to roll back
   halfway. Test 2 pins full non-application including a piggybacked `name`.
4. **Watermark.** The move arms touch neither `last_materialized_on` nor `paused`;
   the only watermark write remains the false→true unpause transition. The
   materialize test pins survival: today still due after the move, booked once,
   onto the new account, in the new currency (`services/recurring_jobs.py`
   untouched, books `tpl.account_id`/`tpl.currency` verbatim — per plan).
5. **Tests: all 6 plan items delivered, no vacuous duplicates.** (1) restamp —
   test 1; (2) explicit null → `ACCOUNT_REQUIRED` — added to the EXISTING
   parametrized required-nulls test rather than duplicated, correct; (3)+(4)
   foreign/missing/archived — one refs test, template pinned unchanged after all
   three refusals; (5) stale echo → 422 whole — test 2; (6) materialize onto new
   account — test 4, also the watermark pin. Only excess: the MINOR-1 arm.
6. **Contract pair.** `openapi.json` diff is exactly the `account_id` property in
   `RecurringTemplateUpdate` (nullable uuid, matching the Field); property order
   alphabetical, consistent with the sorted export (verified against
   `RecurringTemplateCreate`). `schema.d.ts` adds the same two generator-shaped
   lines in the same schema — no hand-edit signature. Both move in one commit.
7. **Comments/docs.** Stale B2 comments rewritten as planned (schemas 113-116 →
   "changeable afterwards", router "currency is never written FROM THE PAYLOAD",
   module docstring's watermark taxonomy gains the move bullet).
   `docs/backend.md:14` already carries the accurate B3 line.
