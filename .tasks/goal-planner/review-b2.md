# Review B2 — reminders + `GET /goals/upcoming` (goal-planner)

Reviewer: code-reviewer, FULL tier (contract change). Scope: the B2 diff only
(domain/goal_plan.py `reminder_date`, goal_plan_reads.py `UpcomingItem`/`_UPCOMING_SQL`/
`read_upcoming_deadlines`, goal_items.py `list_upcoming_deadlines`+`_serialize_upcoming`,
schemas/goal_item.py `UpcomingDeadlineRead/List`, pat_auth pair, test_goal_upcoming.py,
allowlist.ts(+.test.ts) entry, docs/mcp.md, `/goals/upcoming` contract pair).
Gates not re-run (senior-lead's run is authoritative).

## Verdict

**Clean on all focus areas — no BLOCKER, no MAJOR.** 2 MINOR (test coverage
gaps on genuinely breakable behavior), 1 NIT (generated-contract cosmetics).

What was verified and holds:

1. **`_UPCOMING_SQL` correctness** (goal_plan_reads.py:279–335). Anchor scopes by
   `g.user_id = :user_id AND g.archived IS FALSE AND i.parent_id IS NULL`; the
   recursive arm needs no re-scoping because the composite FK pins children to the
   parent's goal. `paid_direct` carries the three-arm bucket exactly per Д1
   (tx currency → base snapshot → live basket), keys both goal-currency arms to one
   basket, and double-guards with `tx.user_id = g.user_id`. The У2 intermediate
   `paid_by_anc GROUP BY (anc, cur)` sits between `unnest(path)` and
   `jsonb_object_agg` — the duplicate-key trap is closed; storing `[amt, ops]` per
   basket (instead of the plan sketch's node-level ops total) is a necessary
   improvement, correctly motivated in the module comment (rateless baskets must be
   counted per-basket). Breadcrumb appends the PARENT's name as recursion steps into
   the child, so a node's array is root→parent, itself excluded — pinned by the test
   (`["Tokyo"]` / `[]`).
2. **Window semantics** (goal_plan_reads.py:527–598) match plan §2 exactly:
   reminder-decides-alone (a past reminder keeps the node out despite an in-window
   deadline — pinned by `test_window_selects_by_reminder_then_by_deadline`);
   `remind_days_before = 0` survives via `is not None` (goal_plan_reads.py:562–567);
   offset with no effective deadline → `reminder_date` None → row absent; baskets
   converted only AFTER the window filter with one `_RateCache` per request; sort key
   `(deciding date, created_at, item_id)` — the `/recurring/upcoming` key
   (recurring.py:434) plus a deterministic id tiebreak.
3. **Performance shape**: one statement for the whole portfolio (no per-goal loop),
   one rate lookup per distinct currency pair, no hidden N+1 in the route.
4. **Contract**: `UpcomingDeadlineRead` nullability matches what the SQL can produce
   (`effective_deadline`/`reminder_date`/`amount_minor` nullable; `currency`,
   `goal_*`, `paid_*`, `breadcrumb` non-null — all backed by NOT NULL columns or
   computed defaults). openapi.json and schema.d.ts agree with the Pydantic schema
   field-for-field; `UpcomingItem.created_at` staying off the wire is intentional
   (sort tiebreak only) and documented. `days` 1–90 default 30 in code, spec, and
   contract. Route declared first in the module AND router mounted before goals.py
   (app.py:238) — both route-order conditions hold; PAT pair present with the
   path_format rationale (pat_auth.py:117).
5. **MCP**: `list_upcoming_goal_deadlines` read-scope, path/method correct;
   "soonest date first" is now accurate; the description's date/minor-units/
   per-row-currency/archived warnings match actual behavior; docs/mcp.md counts
   (33 = 18 read + 15 write) match the allowlist test and the "Отложено" stub is
   removed.
6. **Tests**: all three pin distinct, breakable behavior (intent-vs-fixed-date under
   a deadline move; reminder-decides-alone; archived round-trip with subtree paid,
   breadcrumb and per-row currencies). No vacuous or duplicate tests.

## Findings

**1. MINOR — nothing pins the response sort order.**
`apps/api/tests/test_goal_upcoming.py:66–73` — the `_upcoming` helper re-keys rows
by `item_name`, so every assertion is order-blind, while the sort key is a stated
contract behavior ("the two widgets order ties alike", goal_plan_reads.py:550–552)
and the MCP description now *promises* "soonest date first"
(allowlist.ts:350). Dropping the `selected.sort(...)` line would pass the suite.
Fix: in `test_window_selects_by_reminder_then_by_deadline`, assert on the raw
ordered list once before re-keying — e.g.
`[r["item_name"] for r in resp.json()["items"]] == ["soon", "bare"]` (`soon` at
+5 sorts before `bare` at +10). One line, no new test.

**2. MINOR — `remind_days_before = 0` is guarded only by a comment.**
`apps/api/src/budget_api/services/goal_plan_reads.py:562–567` — the emphatic
comment says a truthiness regression would silently demote "remind on the day
itself" to "no reminder", i.e. the node would be judged by its deadline instead of
its reminder. That is exactly the class of quiet regression the comment fears, and
no test exercises it (the plan's three tests use 3-day offsets and fixed dates).
Fix: one item with `remind_days_before=0` and a deadline placed so the two
readings disagree — deadline OUTSIDE the window with today as the reminder day is
the sharpest contrast (present under `is not None`, absent under truthiness); fits
as one extra node in `TestWindow` without a new test function.

**3. NIT — duplicated `goal-items` tag in the generated contract.**
`apps/api/openapi.json` `/goals/upcoming` (and every goal-items route) carries
`"tags": ["goal-items", "goal-items"]`: the tag is set both at the mount
(app.py:238) and per-route (goal_items.py:419 etc.). Harmless to clients, but it
is committed contract noise no other router produces. Fix: drop the per-route
`tags=[...]` in routers/goal_items.py and regenerate the pair (`pnpm openapi`).
Touches B1's routes too — fine to fold into whichever B-subtask lands last.

---

## Senior-lead disposition (2026-08-26)

- **Finding 1 (sort unpinned)** — принято; raw-order assert добавлен в
  `TestWindow` (mutation-check: удаление `selected.sort` валит тест).
- **Finding 2 (`remind_days_before=0`)** — ОТКЛОНЕНО: при смещении 0 дата
  напоминания РАВНА эффективному сроку, поэтому truthiness-регресс даёт ту же
  `due`-дату и идентичное членство в окне; наблюдаемого контраста не существует
  (подтверждено QA-пробой). Комментарий в коде остаётся единственным стражем —
  осознанно.
- **Finding 3 (дублированный тег `goal-items` в openapi)** — принято, отложено
  до закрытия скоупа: правка задевает роуты B1 и требует регенерации контракта
  поверх состояния, которое параллельно переписывает B3.
- **QA-гэп A6.7** (guard `GOAL_ITEM_REMIND_CONFLICT` без теста — долг B1) —
  закрыт: `TestReminderIntent` в `test_goal_items.py`, три плеча (POST оба →
  422; PATCH-merge → 422; переключение намерения через null → 200).
- **QA-доп**: `TestNoDeadlineAnywhere` — offset без срока отсутствует честно,
  фиксированная дата с `effective_deadline: null` присутствует; её дата = today
  пиннит включающую ближнюю границу окна.

Мета-ревью не пишется: MAJOR/BLOCKER нет (политика 2026-08-18).
