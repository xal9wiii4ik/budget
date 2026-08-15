# Code Review: S4 (goals-domain) + S5 (goals-api) — scope currencies-goals, tier FULL

Reviewer: code-reviewer. Scope: uncommitted diff — `domain/goals.py`,
`tests/test_goals_domain.py`, `schemas/goal.py`, `routers/goals.py`,
`tests/test_goals_api.py`, `app.py` mount, `schemas/transaction.py` rename,
regenerated contract artifacts. Binding spec: plan.md S4/S5 (+ D-List),
grooming-review AM-4/R1, architecture D10/D11/D12. Accepted deviations 1–7 not
re-litigated. Full suite run: **188 passed** (37 of them the new S4/S5 tests).

## VERDICT: REQUEST CHANGES

One BLOCKER (a deterministic 500 on the whole /goals read surface from a
plausible data state), fixable with a small guard + one contrasting test.
Everything else is MINOR/NIT. After the blocker fix the diff is
approve-quality: the catastrophic bug classes I was pointed at are all clean
(verified positively in §Verified below).

---

## Findings

### 1. BLOCKER — `suggested_deadline` overflows `date` → 500 on every /goals read for a user with a tiny positive surplus
**File:** `apps/api/src/budget_api/domain/goals.py:113-117` (crash site),
`apps/api/src/budget_api/routers/goals.py:240-242` (unguarded call site).

`months_to_target` is unbounded (correctly — it is a ceil of
`remaining / available`), but `suggested_deadline(today, months)` feeds the
result straight into `date(year, month, day)`, and `datetime.MAXYEAR` is 9999.
Any goal where `remaining / available_monthly > ~95_700` months produces
`ValueError: year N is out of range`, which the assembler does not catch →
500 on `GET /goals`, `GET /goals/{id}`, and the assembled responses of
`POST /goals` and `PATCH /goals/{id}` — the entire goals surface, for that
user, deterministically, until their data changes.

**Concrete failure scenario (reproduced):** base RUB, free balance = 1 minor
unit (income exceeds expense by 0.01 RUB over the window — an ordinary
near-break-even month triple), one RUB goal with `target_minor = 100_000`
(1000 RUB): `months_to_target(100_000, 0, 1) == 100_000` →
`suggested_deadline(date(2026, 8, 15), 100_000)` raises
`ValueError: year 10359 is out of range`. Verified live against the working
tree. Note `available == 0` is safe (`months_to_target` → None) — it is
precisely the *small positive* surplus, the most degradation-sensitive state,
that crashes. This violates the scope's never-500 honesty stance (D7/D9
spirit; `suggested_deadline` is already nullable on the wire).

**Minimal fix:** make the impossible-horizon case null, in the domain (keeps
the router math-free): change `suggested_deadline` to return `date | None`
and return `None` when the target month exceeds year 9999 (check
`total >= 9999 * 12 + 12` before constructing, or wrap in try/except
ValueError). The router's existing
`suggested_deadline(today, to_target) if to_target is not None else None`
then passes the null through unchanged; `GoalRead.suggested_deadline` is
already `date | None`. Add one contrasting S4 test (huge months → None; sane
months → date) and optionally one API test with a 1-minor surplus fixture.
(Alternative: clamp `to_target`/`suggested` router-side; domain-side None is
smaller and keeps the "callers never see exceptions" property.)

### 2. MINOR — archived-goal waterfall exclusion is implemented but not pinned; a plausible wrong implementation passes the whole suite
**File:** `apps/api/src/budget_api/routers/goals.py:244` (the
`not goal.archived and not completed` guard); gap in
`apps/api/tests/test_goals_api.py`.

The guard is correct, but no fixture exercises it: the default list never
loads archived goals at all; `test_list_order_and_archived_filter`'s archived
goal has no deadline (need 0, consumes nothing either way); the AM-4
consistency fixture in `test_waterfall_allocation` uses a *completed* goal,
not an archived one. An implementation that drops the `archived` check passes
all 188 tests — and the failure it causes is exactly the AM-4 class: the
single GET (which always loads `include_archived=True`) and any
`include_archived=true` list would let an archived goal with a live
deadline/rate consume allocation, silently diverging from the default list's
numbers. **Fix:** give the archived goal in one existing fixture a deadline +
positive need and assert it allocates 0 while the flow past it is unchanged
(one arm added to `test_waterfall_allocation` or the archived-filter test),
plus the single-GET equality on that goal.

### 3. MINOR — `GET /goals/{id}/contributions` has zero test coverage (ordering + pagination unpinned)
**File:** `apps/api/src/budget_api/routers/goals.py:506-539`; gap in
`apps/api/tests/test_goals_api.py` (and in plan S5's own test list — plan gap,
recorded, not the engineer's invention).

The endpoint is a fresh auth surface returning user money data and nothing
exercises it: not the `{items, total}` envelope, not the
`occurred_at DESC, created_at DESC` ordering, not limit/offset. A reversed
ORDER BY (asc — the natural typo) or an offset applied before ordering passes
the suite. The no-oracle side is fine (same `_load_own_goal` wall as the
tested verbs). **Fix:** one test — three contributions across two dates,
assert order + `total` + a `limit=2`/`offset` slice. (House test policy allows
this: ordering direction is genuinely breakable and uncovered.)

### 4. MINOR — progress query is unbounded on the right; future-dated rows are fetched and silently dropped, so the chart's last point cannot reconcile with `saved_minor`
**File:** `apps/api/src/budget_api/routers/goals.py:601-609`.

`ContributionCreate.occurred_at` accepts any date (no future bound —
consistent with transactions), and the grouped query filters only
`occurred_at >= window_start`. A contribution dated in a *future month* is
(a) counted in `saved_minor` / the SUM invariant, (b) fetched into `by_month`
under a key the emit loop never reads, (c) absent from `pre_window`. Result:
the card says `saved_minor = X` while the chart's final `saved_end_minor`
excludes the future rows — a silent, permanent mismatch between two numbers
on the same screen. Cumulative-through-current-month is a defensible
semantic, but today it is an accident of key-mismatch, not a decision.
**Fix:** add the explicit upper bound
`GoalContribution.occurred_at < _shift_month(current_first, 1)` to the
grouped query (intent becomes visible, dead fetch removed) and flag the
card-vs-chart reconciliation rule to plan-web. Related observation (spec
level, no code change): the SUM ≥ 0 invariant holds only for the current
total, so a past-dated withdrawal can make intermediate `saved_end_minor`
points negative — the web chart must tolerate negative Y.

### 5. NIT — bare `next(...)` in `_single_goal_read` turns a concurrent delete into a 500
**File:** `apps/api/src/budget_api/routers/goals.py:314`.

Between `_load_own_goal` and the assembler's re-query (or between PATCH's
commit and its response read), a concurrent `DELETE /goals/{id}` makes
`next(item for item in items if item.id == goal_id)` raise StopIteration →
RuntimeError → 500. Vanishingly rare single-user race, but
`next(..., None)` + raise the existing 404 is one line and matches the
no-oracle path.

### 6. NIT — `_TODAY` frozen at import time in `test_goals_api.py`
**File:** `apps/api/tests/test_goals_api.py:35`.

The router reads the clock per request; the tests compute month boundaries
and `suggested_deadline` expectations from a module-level `_TODAY`. A suite
run that crosses UTC midnight at a month boundary (or any midnight for the
suggested-deadline day component) flakes. Cheap hardening: compute per-test,
or accept as a known once-a-month-at-midnight CI curiosity (recorded here so
a future flake triages in seconds).

### 7. NIT — `(max_priority or 0) + 1` relies on falsy-zero coincidence
**File:** `apps/api/src/budget_api/routers/goals.py:342`.

When the user's max priority is literally `0`, `0 or 0` → 0 → default 1 —
correct, but only coincidentally (the same expression is a classic bug when
the neutral element differs). `(max_priority if max_priority is not None else 0) + 1`
states the intent. No behavior change.

---

## Verified clean (the priorities I was pointed at)

- **Rate directions (the catastrophic class):** `lookup_rate(session, base=goal.currency, quote=base, today)` returns `rate` = *quote-per-one-base* = **base-currency-per-one-goal-unit** (`fx_lookup.RateLookup.rate` "to-per-one-from", direct row or `invert` of the stored twin). The assembler uses `found.rate` for goal→base (`needs` conversion, goals.py:248) and `invert(found.rate)` for base→goal (`available_goal_cur`, goals.py:233-235) — **both correct**, and `test_foreign_currency_goal_converts` pins the production path exactly (only canonical RUB→USD stored; USD numbers ride the inversion; hand-computed 0.0125/80 both directions). Identity lookup makes base-currency goals never-unavailable (`invert(1) == 1`).
- **Auth/no-oracle:** every query is user-scoped (`_load_own_goal`, `_load_goals_ordered`, priority max, `converted_totals`) or scoped through an own-checked goal id (`_saved_sum`, contributions, progress). Foreign == missing on one code path for both the goal wall (404 `GOAL_NOT_FOUND`, all verbs tested) and the nested contribution (`goal_id` AND `id`, wrong-own-goal tested). No leak found.
- **FOR-UPDATE + SUM invariant:** both write endpoints lock the goal row as their *first* statement (`_load_own_goal(for_update=True)`), then read the SUM in the same transaction — under READ COMMITTED the blocked second writer re-reads post-commit state after acquiring the lock, so the check serializes correctly. Guard arithmetic exact on both boundaries (`sum + amount < 0` create / `sum − amount < 0` delete; to-zero allowed both ways, tested both arms). Initial contribution is flush+add+single-commit — atomic. `create_goal` needs no lock (goal invisible pre-commit); `delete_goal` vs concurrent contribution serializes on the row lock or resolves to 404.
- **D-List degradation:** per-goal (null triple + allocation 0 + excluded from `needs`, goal-currency fields still computed) and top-level (any window month's `unconverted_count > 0`) implemented exactly per [SL-3], both contrast tests present and non-vacuous. No 500 on any *no-rate* path (the finding-1 crash is an arithmetic-range path, not a rate path). Accepted deviations 1–7 are internally consistent as implemented (deadline-None goals enter `needs` at 0 and don't block; rate-miss precedence over the needed≤0 short-circuit matches D-List's flag-triple rule).
- **Contract honesty:** `_UNPROCESSABLE` anyOf carries both arms verbatim from the transactions construction (confirmed in regenerated openapi.json); `GoalError` registered via the `_NOT_FOUND` model ref; nullable fields (`realistic`, `months_to_target`, `suggested_deadline`, `deadline`) declared nullable; AM-4 `base_currency` present per-item and top-level, asserted in tests; response models match actual payloads on all 9 routes; 204s carry `response_model=None`.
- **House patterns:** `HTTP_422_UNPROCESSABLE_CONTENT` constant, `*_REQUIRED` loop, `model_fields_set`, `{items, total}` envelope + limit bounds, UTC `_today()` (matches fx router), mount without `prime_rate_limit` (categories construction, comment mirrors fx). `clean_note` rename: both transaction call sites updated, goal import is the only external consumer, no stale `_clean_note` references anywhere; full suite green.
- **S4 domain + tests:** all plan (a)–(u) arms present and genuinely contrasting (toward-−∞ vs toward-zero pin, ceil off-by-one pairs, tie-swap waterfall, leap Feb 29). Single-division floor and `-(-a // b)` ceil idioms exactly as resolved; `max(needed, 0)` clamp per accepted deviation 7.

## Required before merge

Finding 1 (guard + contrasting test). Findings 2–4 strongly recommended in
the same pass (2 and 3 are each one small test; 4 is a one-line WHERE bound);
5–7 at the engineer's discretion.
