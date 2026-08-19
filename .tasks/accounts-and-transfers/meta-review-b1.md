# Meta-review B1 — accounts-and-transfers core

Senior-lead over `review-b1.md` (0 BLOCKER / 1 MAJOR / 1 MINOR / 2 NIT).
Written because a MAJOR was found (wall-clock policy §3).

## MAJOR-1 — 500 on PATCH non-transfer with explicit `"counter_amount_minor": null`
**AGREE.** Verified independently against the diff before dispatching the fix: the
non-transfer arm tested payload values, so an explicit null slipped past the 422
and died on the write-site assert. Real, reachable by any authed user on their own
row, schema-valid payload. Fixed same cycle: the non-transfer arm now decides by
`model_fields_set` (both counter fields, null or value → 422
`COUNTER_FIELDS_WITHOUT_TRANSFER`), pinned by a parametrized contrast test that
fails on the old code (500 / silent no-op respectively). Full suite re-run by me:
**402 passed**. Reviewer's recommended fix shape adopted verbatim (the
"sent-and-unusable → 422" precedent), engineer's test placement in
`TestPatchTransfer` accepted — it is PATCH behaviour.

## MINOR-1 — materializer books onto an account archived after template creation
**PARTIALLY AGREE.** The observation is correct and worth pinning; the behaviour is
also the right one, so no code change. Decision (mine, now pinned): the scheduler
KEEPS booking onto an archived account. Silently skipping a standing order in a
scheduler would drop expected money movements with no user-visible refusal — worse
than landing money on a retired account whose balance is still honestly reported
(`GET /accounts?include_archived=true`). Matches the archived-category precedent
(post-hoc archive tolerated on existing attributions). B2 brief will carry a
one-line doc duty for this in `docs/backend.md`'s recurring section.

## NIT-1 — no indexes on the three new FK columns
**AGREE with leaving as is.** Every current query rides the `user_id` indexes and
D13 volumes make FK seq-scans irrelevant; accounts are hard-deleted only inside
the user cascade. Revisit only if B2's `account_id` list filter shows up in a slow
log nobody expects to exist.

## NIT-2 — IntegrityError-recovery arm not raced with a transfer body
**AGREE with deferral.** The arm is shape-agnostic and `_serialize` is a pure
function of the row (the C-3 payoff); a transfer variant would re-assert the same
code path — exactly the redundant test the project rule forbids.

## Outcome
B1 ACCEPTED after the MAJOR-1 fix cycle. Gates (my authoritative re-run):
pytest 402 green, ruff + format clean, pyright 0, alembic upgrade/check green
(dev DB at 0008), contract pair regenerated with no residual drift (api-client
46 green), `pnpm -r typecheck` red ONLY in apps/mobile + apps/web (expected
required-`account_id` fallout, owned by W1/W2/MOB). QA STOP-probes S1-1..S1-5:
5/5 PASS.
