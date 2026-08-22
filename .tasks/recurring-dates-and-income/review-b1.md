# Code review — B1 (recurring start_date + GET /recurring/upcoming)

Reviewer: code-reviewer. Diff: uncommitted working tree @ main (45b9948) + new
`apps/api/alembic/versions/0010_recurring_start_date.py`. Gates NOT re-run
(senior-lead: 470 passed, ruff/pyright/alembic clean, PATCH-gate mutation killed).

## Verdict: APPROVE — 0 BLOCKER, 0 MAJOR, 1 MINOR, 3 NIT

Implementation matches plan.md / architecture.md A1–A7, B1–B6 including all PM
2026-08-22 amendments. No sequence of API requests can move the watermark below
`min(current, today)` (proof sketch below). The one real double-booking vector I
found is a concurrency race that PRE-EXISTS in the unpause path — recorded as
MINOR follow-up, not a defect of this diff.

## Findings

### MINOR-1 — PATCH ↔ materializer write race on the watermark (pre-existing pattern)
`routers/recurring.py` (`update_template`: start_date block ~line 605, null branch,
and the pre-existing unpause `max()`), vs `services/recurring_jobs.py:97-101`.
`_load_own` reads the template WITHOUT `with_for_update`; the job locks and
advances the watermark in its own transaction. Interleaving: PATCH reads watermark
X → job books X+1..today, commits watermark=today → PATCH commits
`start-1` (where X < start ≤ today) or `min(X, today) = X` → watermark rewinds
below today → next run re-books the gap. Window is milliseconds around the daily
00:30 UTC run / boot catch-up, and the identical exposure already exists for
unpause SL-A (`max(stale, today-1)` can also land below the job's fresh value).
B1 widens the number of stale-read watermark recomputations but introduces no new
class. Suggested follow-up (out of this diff): `with_for_update()` in `_load_own`
on the PATCH path, or an optimistic `WHERE last_materialized_on = :read` guard.

### NIT-1 — `MAX_START_DATE` ceiling invisible in the contract
`schemas/recurring.py` `Field(le=MAX_START_DATE)`: Pydantic does not export a date
`le` into JSON schema — `openapi.json` / `schema.d.ts` show `start_date` as a bare
nullable date (grep "2999" → 0 hits; `days` DOES export `minimum/maximum`). Runtime
enforcement is real and pinned by `test_far_future_start_date_is_refused_instead_of_500`.
Consider `Field(..., description=...)` so clients at least read the ceiling; the
`#:` comments do not reach the exported schema.

### NIT-2 — PATCH raises business 422 after in-memory mutations
`update_template`: `START_DATE_TOO_EARLY` fires after name/amount/kind/anchors are
already assigned to the ORM object. Safe today — no query (hence no autoflush)
between the mutation section and commit, and `get_session` discards an uncommitted
session on close — but the safety is positional. A one-line comment on the gate
("no flush can happen before commit") would keep a future insert of a query there
from silently persisting half a PATCH. Same latent property as the pre-existing
anchor writes; not new.

### NIT-3 — upcoming sort tiebreak relies on `created_at` uniqueness
`list_upcoming` sorts by `(due_on, rank)` where rank = query order
`(created_at, id)` — a faithful implementation of B5. If two templates ever share
a `created_at` timestamp, the id tiebreak is the UUID order, which the test's
"creation order" expectation only accidentally matches. Purely theoretical over
HTTP round-trips; noting so a future bulk-import doesn't surprise the test.

## Verified clean (what I actually checked)

- **Watermark invariant, all branches**: create seed `start-1 ≥ today-1` (gate
  `start < today` → 422 first); PATCH guard `start ≤ min(wm, today)` → 422 makes
  the exact assignment `start-1 ≥ min(wm, today)` safe; null branch lands on
  `min(wm, today)`; booked region ≤ `min(wm, today)` holds because the job books
  only `≤ run_date` and advances exactly to `dates[-1]` (recurring_jobs.py:104-157).
  Compositions traced: start+unpause (both orders of effect — `max` after `min`/
  exact seed, order-independent), start on paused row, null on future seed,
  B3 account move (never touches watermark), repeated seed/clear cycles. No
  request SEQUENCE can rewind below `min(current, today)`.
- **Gate order / no-oracle**: create checks payload-only date gates before the
  account load; PATCH eff-pair start/end sits with the other payload+stored gates
  BEFORE `_require_own_account`. `START_DATE_TOO_EARLY` after the account gates
  reveals only the owner's own watermark floor — foreign/missing account stays
  byte-identical 404. No new oracle.
- **/upcoming**: read-only (watermark never written), `user_id`-scoped, paused
  excluded, route declared between the list and the parameterized routes, `days`
  bounded 1..90 (≤13 dates/weekly template — MAX_OCCURRENCES=366 never binds),
  end_date clamp inclusive, arrears floored at `today-1` via the shared
  `upcoming_due_dates` (B4 — `_next_due_on` refactor is behaviorally equivalent:
  same floor, `end_date` → horizon replaces the old `> end_date → None`).
- **Timezones**: all router math on `_today()` (UTC), same clock as the job.
- **Migration 0010**: nullable add-column, no default/backfill, no watermark
  touch, symmetric downgrade, `down_revision="0009"` per the recorded decision.
- **Contract**: openapi.json +163/-0, schema.d.ts +119/-0 — purely additive,
  clearly generator output (docstrings piped through), frozen mobile unaffected.
  PAT pair `("GET", "/recurring/upcoming")` added; auto-covered by the pat_auth
  allowlist-export test.
- **Tests**: assertions genuinely kill the claimed breakages (checked each: seed
  deletion, PATCH-guard deletion, null-branch `today-1` regression, payload-only
  start/end validator, schema ceiling). Exact-list /upcoming assert with two
  independent test-local calendar oracles; A4 clock rule held (the one
  forward-dated `materialize_due` is followed only by direct DB asserts, no
  request). Expected fixtures re-derived by hand (weekly/monthly/ending/late/
  arrears/foreign) — all correct, month-length edge handled by `due <= horizon`
  filters.
