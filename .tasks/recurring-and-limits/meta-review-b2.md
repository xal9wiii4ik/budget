# Meta-review: B2 (senior-lead over review-b2.md)

## Rulings on findings
1. **AGREE (minor).** The week-branch ANCHOR_MISMATCH was genuinely unpinned —
   the reviewer's mutation argument holds (check deleted → suite green while a
   client-sent value is silently discarded, the exact R1(5) failure class), and
   the week→month stale-anchor clearing had no arm either. FIXED: two arms added
   to `test_patch_unit_switch_rules` (weekly + explicit dom → 422
   ANCHOR_MISMATCH; week→month switch → 200, dom=5, weekday null). Kill
   verified in the fix round: week-branch guard commented out → exactly the new
   arm FAILED (200 != 422); restored md5-identical
   (bef6d554270c7c84bb8c1c5f4fe05738 pre/post); re-run green.
2. **AGREE (nit).** Docstring count corrected ("The tests below that call
   materialize_due" — six, not four).
3. **DEFER (nit).** Midnight-straddle flakiness is inherent to the plan's
   mandated relative dating and is now recorded here and in review-b2.md; if a
   00:00-UTC flake ever appears, this is the diagnosis, not a product bug.

## Senior diff-gate notes (pre-review, for the record)
- Auth scoping verified on every query (`_load_own`, list); no-oracle 404 with
  byte-identical foreign/missing bodies pinned in B2-10.
- SL-A read in source: transition-aware (`template.paused and not
  payload.paused`), `max(watermark, today−1)`, checked BEFORE `paused` is
  assigned; AM-7 arm asserts the arrears watermark survives an ordinary edit
  AND both pending dates then materialize.
- SL-B: field on TransactionRead only; absent from write DTOs; B2-12 pins wire
  + DB (forge and re-point both inert).
- Watermark on create = today−1 (DB-read, off the wire); next_due_on floor per
  OQ-1/AM-9 with the inclusive end_date boundary.
- Contract pair regenerated together, additive-only (938 insertions, 0
  deletions); regen re-run by me → deterministic, identical diff.
- Accepted engineer deviations (argued, in-report): local `job_sessionmaker`
  fixture duplicated from test_recurring_jobs.py (extracting would edit
  conftest + a B1b file outside B2's diff); AM-7 arrears via
  `_shift_month_clamped(today, −2)` for exact-list assertions; B2-7's extra
  `end_date == next due` accept-contrast arm (pins the inclusive boundary).

## Gate trail (senior re-run post-fix, authoritative)
- `uv run pytest` on PG 5443 (TEST_DATABASE_URL): **323 passed**
  (296 at HEAD + 27 in test_recurring_api.py).
- `ruff check` / `ruff format --check` (101 files) / `pyright` strict: clean.
- `pnpm openapi` deterministic; `pnpm --filter @budget/api-client typecheck`
  clean; `test` 38 passed. schema.d.ts: `recurring_template_id: string | null`
  on TransactionRead (absent from Create/Update), `RecurringTemplateRead` with
  `next_due_on`.
- O-1: both artifacts modified, to be committed WITH the code. O-5 no new
  index. O-8 pinned (B2-8/9/10/12 + AM-7). O-10 no notification surface.
- QA per 2026-08-18 cadence: NO live QA at B2 (not a new integration boundary);
  TC-B2-1..7 stay pending for the scope-end full run.

## Known ripple (PM decision at commit)
`apps/web` typecheck is red on two test fixtures constructing TransactionRead
literals (`groupByDay.test.ts:9`, `rowDisplay.test.ts:10`) — each needs one
line `recurring_template_id: null`. Expected consequence of the additive
required response field. B2's brief forbade touching apps/web; PM may fold the
2-line fix into the B2 commit or accept a red root typecheck until W3.

**B2 verdict: ACCEPTED — ready for PM commit** (B2 paths only; the tree also
carries a parallel session's apps/mobile changes — not B2's).
