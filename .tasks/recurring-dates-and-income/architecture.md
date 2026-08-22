# Architecture Plan: recurring-dates-and-income (API side)

## Context
Add user-controlled first-charge date to recurring templates and an upcoming-charges
read endpoint, without ever letting either rewind the `last_materialized_on`
watermark (the single idempotency truth — double booking is the #1 risk).

## A. start_date on recurring templates

**A1. Column.** New nullable `start_date DATE` on `recurring_templates`. Stored (edit
form must echo it), but it is INPUT to watermark computation at create/PATCH time
only. The materializer (`services/recurring_jobs.py`) never reads it and stays
byte-identical; the watermark remains the sole idempotency truth. NULL = legacy
"no floor" behavior.

**A2. Create. (amended per PM 2026-08-22)** Guarded by A3, the formula is exact:
`watermark = start_date − 1 day` when sent (guard guarantees ≥ today−1);
`today − 1` when null/omitted. No max needed. Verified load-bearing claims stand:
- `_due_template_ids` filters `last_materialized_on < today` (recurring_jobs.py:59)
  → a future-start template (watermark = start−1 ≥ today) is skipped until
  today ≥ start_date. CONFIRMED.
- `due_dates_between` returns `[]` when `through <= after` (recurrence.py:82-98).
  CONFIRMED.
- `_next_due_on` floors at `max(watermark, today - 1)` (recurring.py:174) and
  `next_due` is strictly-after → first rendered/booked due date ≥ start_date. CONFIRMED.

**A3. Past start_date: REFUSED, not clamped. (amended per PM 2026-08-22)** No
echo-without-effect anywhere. CREATE: sent `start_date < today` (UTC, router
`_today()`) → 422 `START_DATE_TOO_EARLY`, router-level check. The clamp is DELETED.
Backfill remains rejected for the same reasons as before (retroactive rows silently
move balance/stats/limits/goals with no preview or undo); a user who wants history
adds past transactions explicitly. Error copy intent: «прошлые списания не
переписываются; для более ранней истории — новый шаблон или ручные операции».

**A4. PATCH start_date. (amended per PM 2026-08-22)** Rewind-safety fact
(verified): the materializer books only dates ≤ its run_date and advances the
watermark only to `dates[-1]` (recurring_jobs.py:104-108, 157), so the booked
region is always ⊆ (−∞, min(current_watermark, today)]. Rules:
- sent non-null `start_date` ≤ `min(current_watermark, today)` → 422
  `START_DATE_TOO_EARLY`.
- valid non-null `start_date` → `watermark = start_date − 1`, EXACT assignment:
  the guard guarantees start−1 ≥ min(current, today), so no min/max composition
  is needed for this contribution. A future seed stays correctable
  (min(seed-watermark, today) = today → any start_date ≥ today+1 is valid and
  rewinds the seed exactly; the typo trap Sep 30 → Sep 5 fix survives).
- explicit `null` → clears column, `watermark = min(current_watermark, today)`:
  un-booked future seed is undone, charges resume from tomorrow.
- Composition: unpause SL-A `max(·, today−1)` still composes AFTER; order-independent.
- Safety note: for an ACTIVE template with a lagging watermark, a valid
  start_date between watermark and today only SKIPS pending arrears (they would
  have booked anyway) — it can never create bookings that weren't already
  pending, because rewinds are refused.
- Clock guard: PATCH/create math MUST use the router's `_today()` (UTC,
  recurring.py:102-103), the same clock as the materializer. Test rule: never
  inject `materialize_due(today=...)` beyond the `_today()` a subsequent request
  in the same test would compute.

**A5. Anchor interplay.** start_date is a FLOOR, not an anchor. First charge =
first due date per day_of_month/weekday on or after start_date (falls out of A2 +
strict `next_due`). Confirmed; no alternative proposed — an anchor-override would
duplicate the anchor fields.

**A6. Migration 0010. (amended per PM 2026-08-22)** Slot is 0010, not 0009
(0009 taken by transaction-details scope). `op.add_column` nullable `start_date`,
existing rows stay NULL, no server_default, NO watermark touch. Do NOT backfill
`created_at::date`. DECISION (not a gap): no DB CHECK for start ≤ end —
app-level only, because both dates are nullable and the constraint would carry
three NULL branches; the one deliberate app-level exception.

**A7. Validation. (amended per PM 2026-08-22)** Effective-pair rule (eff_* PATCH
pattern): non-null `start_date` > non-null `end_date` → 422
`START_DATE_AFTER_END_DATE`. Checked at ROUTER level on CREATE too — same string
code and same response shape as PATCH, deliberate duplication so the web routes
one code to one field regardless of branch. The create-side model_validator plan
is dropped. Additionally (PM D4): upper bound `le=date(2999,12,31)` on
`start_date` in BOTH schemas — without it a far-future seed drives next_due past
calendar range → 500 on plain POST. Mandatory test. Add `START_DATE_TOO_EARLY`
and `START_DATE_AFTER_END_DATE` to `_UNPROCESSABLE` docs; RecurringError envelope
unchanged. `start_date` (nullable) added to RecurringTemplateRead.

## B. GET /recurring/upcoming

**B1. Shape: separate endpoint**, not a field on the list. The /transactions widget
needs a flat, date-sorted merge ACROSS templates; a per-template array on the list
would push merge/sort/flatten to the client (client date assembly — against the
invariant) and bloat the management-screen payload. Declared in routers/recurring.py.
No GET `/{template_id}` exists so there is no route-order collision, but declare it
before the parameterized routes anyway (transactions landmine precedent).

**B2. Horizon.** Query param `days`, default 30, bounds `ge=1 le=90` (Pydantic 422
outside). Days-window over next-N-per-template: due_dates_between is already a
window generator, and a calendar window answers the widget's actual question
("what hits my accounts soon"). Volume: weekly template ≈ 4–5 rows/30d, monthly 1;
tens of templates → low hundreds worst case at 90d. Unpaginated envelope, D10 style.

**B3. Mechanics. (amended per PM 2026-08-22)** RULE, not side effect: the widget
shows what has NOT YET HAPPENED — every charge dated today-or-later that is not
yet materialized. The floor `after = max(last_materialized_on, today − 1)`
implements exactly this (today booked → watermark=today → today's row absent; not
yet booked → present). `through = min(today + days, end_date or ∞)`; emit
`due_dates_between(unit, anchors, after, through)`. Paused excluded (same
predicate as _next_due_on). Future-start templates included from start_date
automatically (watermark = start−1 IS the floor). Read-only: watermark is read,
never written.

**B4. Shared helper, no duplication.** Extract the floor+end-clamp into
`domain/recurrence.py` (pure, no IO — takes `watermark/today/end_date` scalars):
one helper both `_next_due_on` and the endpoint call, so "first due ≥ today" has
one definition. Refactor `_next_due_on` onto it in the same change.

**B5. Response item. (amended per PM 2026-08-22)** Server computes everything,
client renders verbatim: `{template_id, name, amount_minor, currency, kind,
due_on, account_id, category_id (nullable)}`. Sorted by `(due_on, created_at,
id)` — stable. New schemas `UpcomingChargeRead` / `UpcomingChargeList{items}` in
schemas/recurring.py. Rows due today carry an explicit "today" marker in the web
UI, labeled CLIENT-side via `due_on == UTC-today` compare (calendar labeling per
verdict C reasoning; UTC to match the server's `_today()`). No server field
added. PM decision, permanent: singleness-of-booking proof stays pytest-only
(P-10/P-11); no test endpoint for the materializer will ever ship.

**B6. PAT allowlist.** CONFIRMED: pat_auth.py allowlist is fail-closed on
(method, path_format); `/recurring` today has exactly GET/POST/PATCH pairs
(pat_auth.py:114-116). Add `("GET", "/recurring/upcoming")` or PATs 403
`TOKEN_ENDPOINT_FORBIDDEN`. GET is scope-neutral (read suffices). CORS verb list
already has GET — no change. openapi.json + schema.d.ts regenerate, one commit.

## C. Goals free-balance: verdict
Keep D11 (3 full months, partial excluded). The complaint is a comprehension gap,
not a math bug: past-month income already recalcs; same-month income moving the
baseline daily would make "monthly free" jitter with payday timing — worse, not
better. UI explanation is the right scope. The API need NOT expose window
boundaries: deriving the "May–July" label from today's date is pure calendar
labeling, not money arithmetic — the invariant bans client MONEY math, not date
formatting the client already does elsewhere (next_due_on rendering). Agree with
the lean; no API change.

## What this does NOT decide
- Web form/i18n details for start_date and the income-form rework (items 3;
  frontend plan's scope).
- Exact helper signature in domain/recurrence.py; test selection (engineer).
- Widget visual design, row count shown client-side (render-side truncation of a
  server-sorted list is fine).
