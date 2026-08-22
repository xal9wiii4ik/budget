# Implementation Plan: recurring start_date + GET /recurring/upcoming (backend B1)

Scope `recurring-dates-and-income`, API half. ONE merged subtask (wall-clock policy):
migration + model/schemas + create/PATCH watermark seeding + shared domain helper +
the upcoming endpoint + PAT pair + contract regen + tests, in one diff.

**Review tier: FULL** — migration, money/watermark logic (double-booking risk),
contract change. code-reviewer runs; no `/review-pr` self-review substitute needed.

Binding: `architecture.md` A1–A7, B1–B6, C, **as amended per PM 2026-08-22** (A3/A4
replaced by refuse-instead-of-clamp semantics, below). C = no API change (goals
free-balance stays D11) — nothing to implement.

## Approach (short)

`start_date` is INPUT to the watermark at create/PATCH time and a stored echo for the
edit form; `services/recurring_jobs.py` is NOT touched — the watermark stays the sole
idempotency truth (A1). `/recurring/upcoming` is read-only over the same
floor+end-clamp definition `next_due_on` already uses, extracted into `domain/` so the
two can never disagree (B4).

**Per PM 2026-08-22 — no clamping of backwards `start_date`.** A rewind into the
already-booked region can only either lie (echo a date that has no effect) or rewrite
history (re-book settled days). Both are refused with 422 `START_DATE_TOO_EARLY`
instead. Valid forward moves on a lagging active template only SKIP already-pending
arrears — they never create new retro bookings. The future-seed correction path
survives untouched: for a template whose watermark is in the future,
`min(watermark, today) == today`, so any `start_date ≥ today + 1` is accepted.

## Decisions (recorded, per PM 2026-08-22)

- **Migration slot is 0010, not A6's "0009"** — that slot is taken by
  `0009_original_amounts_country_and_profile_i18n.py` (transaction-details scope, merged
  after the architecture was written). Ships as **0010**, `down_revision="0009"`.
  Everything else in A6 (nullable, no server_default, no backfill, no watermark touch)
  holds verbatim. Deviation accepted by PM; this is now the recorded decision.
- **No DB CHECK for `start_date <= end_date`** — app-level only (create router + PATCH
  effective pair). Both dates are nullable, so a CHECK would carry three NULL branches
  for a rule the API already owns end-to-end; legacy rows are unconstrained anyway.
  (Was an open question; PM decided app-level.)
- **`START_DATE_AFTER_END_DATE` is raised from the ROUTER on BOTH create and PATCH** —
  deliberate duplication of the rule (create checks the payload, PATCH the effective
  pair). PM accepts the duplication to get one uniform response shape, so web maps one
  string code to one field. The create-side `model_validator` is DROPPED.
- **`start_date` upper bound `le=date(2999, 12, 31)` on BOTH schemas** (Create + Update).
  Without it a near-`date.max` seed makes `next_due` compute past the calendar →
  `ValueError` → 500. Test MANDATORY (test 8), overriding the earlier "plain Pydantic,
  no test needed" call.
- **PM widget decision (upcoming = not-yet-materialized, due ≥ today) needs NO backend
  change** — the B3/B4 floor `max(watermark, today - 1)` with strict-after semantics
  already yields exactly that set. Do not "fix" this later; changing the floor would
  desynchronise `/upcoming` from `next_due_on`.

## Files to modify

- `apps/api/src/budget_api/models/recurring_template.py` — `start_date: Mapped[date | None]`
  nullable `Date`, next to `end_date`. No CHECK (see Decisions). Docstring line: input to
  the watermark, never read by the job.
- `apps/api/src/budget_api/schemas/recurring.py` — `start_date` on Create (nullable,
  default None, `le=date(2999, 12, 31)`) / Update (nullable, same bound) / Read.
  **No `model_validator`** (per PM 2026-08-22). `UpcomingChargeRead` + `UpcomingChargeList`.
- `apps/api/src/budget_api/domain/recurrence.py` — new `upcoming_due_dates(...)` (B4);
  pure, no clock read.
- `apps/api/src/budget_api/routers/recurring.py` — create gate + seed, PATCH gate + seed,
  eff-pair start/end gate, `_next_due_on` refactored onto the helper, `_serialize` carries
  `start_date`, new `GET /upcoming` declared BEFORE the `/{template_id}` routes,
  `_UNPROCESSABLE` doc mention of the two new codes.
- `apps/api/src/budget_api/pat_auth.py` — one line: `("GET", "/recurring/upcoming")` (B6).
- `apps/api/openapi.json` + `packages/api-client/src/generated/schema.d.ts` — regenerated
  TOGETHER by `pnpm openapi` from repo root, one commit (never hand-edited). Additive
  only → frozen mobile client unaffected.
- `apps/api/tests/test_recurring_api.py` — the 8 tests below (two new classes).

## New files

- `apps/api/alembic/versions/0010_recurring_start_date.py` — `op.add_column("recurring_templates",
  sa.Column("start_date", sa.Date(), nullable=True))`; symmetric `op.drop_column` downgrade
  (conftest tears down with `downgrade base`); module docstring in the 0008/0009 style
  stating: NULL = legacy behaviour, no backfill of `created_at::date` (A6), watermark untouched.

## Code skeletons

### domain/recurrence.py (B4) — the ONE definition of "still ahead"

```python
def upcoming_due_dates(
    unit: RecurrenceUnit,
    *,
    day_of_month: int | None,
    weekday: int | None,
    watermark: date,
    today: date,
    end_date: date | None,
    through: date | None = None,   # None = unbounded (the next_due_on caller)
    limit: int = MAX_OCCURRENCES,
) -> list[date]:
    """Due dates in ``(max(watermark, today-1), min(through, end_date)]``.

    Floor = the today-floor of OQ-1 (arrears are never rendered/listed); clamp =
    end_date is INCLUSIVE. Nothing here reads the clock: ``today`` is a parameter.
    This floor IS the PM widget rule "upcoming = not yet materialized AND due >= today".
    """
```

- `_next_due_on` becomes: `dates = upcoming_due_dates(..., through=None, limit=1)` →
  `dates[0] if dates else None`, keeping the `paused → None` guard in the router
  (paused is a template fact, not date math).
- `through=None` → `date.max` internally; `min` with `end_date` when set.

### routers/recurring.py — create (A2, semantics per PM 2026-08-22)

```python
today = _today()
start = payload.start_date
if start is not None:
    if start < today:
        raise HTTPException(422, detail="START_DATE_TOO_EARLY")
    if payload.end_date is not None and start > payload.end_date:
        raise HTTPException(422, detail="START_DATE_AFTER_END_DATE")
seed = (start - timedelta(days=1)) if start is not None else today - timedelta(days=1)
```
`start_date == today` is VALID (books today on the next run). No clamp arm exists any
more, so the endpoint can never echo a date that had no effect.

### routers/recurring.py — PATCH, placed BEFORE the existing `paused` block

```python
if "start_date" in fields:
    floor = min(template.last_materialized_on, today)   # min-clamp on a future seed
    if payload.start_date is None:
        template.start_date = None
        template.last_materialized_on = floor           # unchanged behaviour
    else:
        if payload.start_date <= floor:
            raise HTTPException(422, detail="START_DATE_TOO_EARLY")
        template.start_date = payload.start_date
        template.last_materialized_on = payload.start_date - timedelta(days=1)
# then the existing unpause SL-A max() composes on top — order-independent
```
The guard makes the EXACT assignment safe: `start_date > floor` ⇒
`start_date - 1 >= floor = min(current, today)`, so the watermark never moves backwards
past today and today's booking can never be repeated. `today` = the router's `_today()`
(A4 clock guard). B3 account-move path untouched.

### routers/recurring.py — eff-pair start/end gate (PATCH; right after the anchor block,
before the account load: payload+stored only, so it can never become an account oracle)

```python
eff_start = payload.start_date if "start_date" in fields else template.start_date
eff_end   = payload.end_date   if "end_date"   in fields else template.end_date
if eff_start is not None and eff_end is not None and eff_start > eff_end:
    raise HTTPException(422, detail="START_DATE_AFTER_END_DATE")
```
Create raises the SAME string code from its own payload-only check above (per PM
2026-08-22): identical `{"detail": "START_DATE_AFTER_END_DATE"}` shape on both verbs.

### routers/recurring.py — GET /upcoming (B1–B5)

```python
@router.get("/upcoming", response_model=UpcomingChargeList)
async def list_upcoming(
    user: User = Depends(current_user_jwt_or_pat),
    days: int = Query(default=30, ge=1, le=90),
    session: AsyncSession = Depends(get_session),
) -> UpcomingChargeList:
```
- Declared before `PATCH/DELETE /{template_id}` (transactions route-order landmine).
- One query: own, `paused.is_(False)`, ordered `(created_at, id)`; per template
  `upcoming_due_dates(..., watermark=tpl.last_materialized_on, today=_today(),
  end_date=tpl.end_date, through=_today() + timedelta(days=days))`; flatten; sort by
  `(due_on, created_at, id)` — the tuple carried alongside the row, list order supplies
  the tiebreak.
- Read-only: the watermark is READ, never written. Future-start templates ride in for
  free (their watermark IS start−1).
- Item: `{template_id, name, amount_minor, currency, kind, due_on, account_id, category_id}`.
- No business 422 of its own (`days` is a bounded Query) → no `responses` override
  (the `stats_monthly` precedent).

## Tests (8, `apps/api/tests/test_recurring_api.py`)

Aligned with Section A of the merged `qa-checklist.md` (P-4/P-10/P-11 per PM 2026-08-22).
Existing coverage reused, NOT duplicated: `TestNextDue`/`TestDueDatesBetween`
(`test_recurrence.py`) and `test_next_due_on_semantics` already pin the floor,
strict-after and end_date-inclusive rules, so the **B4 refactor needs no new test** —
those are its equivalence oracle. The PAT pair is auto-covered by
`test_pat_auth.py::test_every_allowlisted_pair_exists_in_the_exported_openapi`; the
router-level 401 exists once already. `days` bounds are pure Pydantic → no test.

`class TestStartDate`
1. `test_future_start_seeds_the_watermark_so_nothing_books_before_it` — claim: the A2
   seed makes a future-start template invisible to `_due_template_ids` until its start,
   and the FIRST booked date is on/after `start_date`. (A naive `today-1` seed books the
   pre-start occurrence.)
2. `test_past_start_date_on_create_is_refused_not_silently_clamped` (P-4) — claim: the new
   create gate. `start_date = today - 1` → 422 `START_DATE_TOO_EARLY`; CONTRAST
   `start_date = today` → 201 (pins that the boundary is `<`, not `<=`, so the gate is not
   just "any start_date fails").
3. `test_patch_start_date_cannot_rewind_into_the_booked_region_but_may_skip_forward`
   (P-10) — claim: the PATCH guard + exact assignment. Today already booked (one row);
   PATCH `start_date = today` → 422 and STILL exactly one row; PATCH
   `start_date = tomorrow` → 200, watermark == today, re-running the materializer books
   nothing new.
4. `test_explicit_null_start_date_clears_the_column_without_rewinding_the_watermark`
   (P-11) — claim: null clears the column and lands the watermark on
   `min(current, today)`; after today's booking that is today, so no second row for today
   and charges resume tomorrow. (Also covers the future-seed release: a future seed
   collapses to today.)
5. `test_start_after_end_is_refused_with_the_same_code_on_create_and_on_patch` — claim:
   BOTH arms return the identical string `START_DATE_AFTER_END_DATE` body (not a Pydantic
   array on create), and the PATCH arm judges the EFFECTIVE pair (start-only payload vs
   STORED `end_date`), which a payload-only validator misses.
8. `test_far_future_start_date_is_refused_by_the_upper_bound_instead_of_500` — claim: the
   `le=date(2999, 12, 31)` bound. `start_date = 9999-12-31` on create → 422, not a 500 from
   `next_due` walking past the calendar; same on PATCH.

`class TestUpcoming`
6. `test_window_lists_only_future_charges_across_templates_in_due_order` — ONE exact-list
   assert over a fixture set covering every rule at once: active weekly + monthly on two
   accounts/currencies, a paused one (absent), one whose `end_date` falls inside the
   window (clamped, inclusive boundary), one with a future start inside the window
   (present, first date ≥ start), one in arrears (rewound watermark → only its FUTURE
   date, never the pending past one), sorted ascending.
7. `test_days_widens_the_horizon_beyond_the_default_window` — claim: `days` really drives
   `through`; a charge 45 days out is absent at the default and present at `days=90`.

Gates: `TEST_DATABASE_URL=postgresql+asyncpg://budget:budget@localhost:5443/budget_test
uv run pytest` in `apps/api`, plus `pnpm turbo lint typecheck test` from root (the
openapi drift test fails until `pnpm openapi` is run and both artifacts are staged).

## Open questions (senior-lead)

1. Should `/recurring/upcoming` exclude templates whose ACCOUNT was archived after the
   fact? Plan says NO — the materializer books them anyway (B2/MINOR-1), so hiding them
   would make the widget lie about money that will move.

(The three earlier questions — create-side error shape, far-future upper bound, DB CHECK —
were decided by PM 2026-08-22 and now live under Decisions.)

## Risks

- **Double booking** (the #1 risk): the PATCH exact assignment is only safe BECAUSE of the
  `start_date > min(current, today)` guard — if that guard is ever loosened, the watermark
  can rewind below today and re-book settled days. The A4 test rule holds: never call
  `materialize_due(today=X)` with an X ahead of the `_today()` a later request in the same
  test computes.
- Refusal semantics are user-visible: a lagging active template whose owner moves
  `start_date` forward SKIPS pending arrears (by design — the floor never rendered them).
- Route order: `/upcoming` after `/{template_id}` would 422 as a UUID path param.
- Contract pair drift if `pnpm openapi` is skipped (test_openapi_export catches it).
- `alembic check` drift if the model column and 0010 disagree.
- Timezone: all date math on `_today()` (UTC), same clock as the job.

## Estimates (agent-minutes)

- Writing (migration + model/schemas + router + domain + PAT + regen + 8 tests): **100**
  (+10 vs the pre-PM figure: two router gates instead of one validator, plus tests 2/8)
- Gates (ruff, pyright, pytest full suite, openapi regen + drift test, fix cycles): **25**
- Verification (diff re-read, live curl smoke of `/recurring/upcoming` + a PATCH seed): **20**

Files touched: **9** (1 new migration, 5 source, 2 generated contract artifacts, 1 test file).
