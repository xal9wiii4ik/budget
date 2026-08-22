# Scope: recurring-dates-and-income

Groomed 2026-08-22. Web + API only; MOBILE EXPLICITLY OUT (user decision, separate scope later).

## User complaints (verbatim intent) + verified facts

### 1. Start date for recurring templates
"регулярные непонятно когда снимаются, надо чтобы можно было выставить дату".
- FACT: no start date exists. Create stamps `last_materialized_on = today - 1`
  (routers/recurring.py); first charge = next natural due date after creation.
- FACT: `next_due_on` IS rendered on /recurring (TemplateRow.tsx `recurring.nextOn`)
  for active templates. The gap is CONTROL (pick first-charge date), plus possibly
  prominence of the display.
- Requirement: start_date on create AND edit; existing templates (no start_date)
  must keep exact current behavior. Watermark is the idempotency mechanism —
  start_date must NEVER rewind it into double booking. Money logic → FULL tier.

### 2. Upcoming charges widget on main screen (/transactions)
"на главное надо показывать предстоящие снятия".
- FACT: no endpoint exists. `domain/recurrence.due_dates_between` is the pure
  generator to build one. Server computes (no client date/money math — invariant).
- Design: horizon (30 days vs next-N — decide and justify), paused templates
  excluded (server already nulls next_due_on), end_date clamps the window.

### 3. Income form mirrors expense form
"если выбираешь доход то не меняется форма".
- FACT: TransactionFormModal.tsx only swaps the category optgroups (L469-470,
  1002-1020); labels/field order/merchant are expense-worded for both kinds.
- Requirement: walk the whole form; for income — "куда пришло" not "с какой карты
  списано", "получено" not "списано", merchant → источник or hidden. All copy via
  i18n dict (dict.en.ts key set + ru mapped type). Web only in this scope.

### 4. Goal recalc after income
"нужен пересчет цели после этого".
- FACT: hypothesis (b) (cache) is FALSE — all three tx mutations invalidate
  ['goals','list'] (data/transactions.ts invalidateGoalsList), and
  free_balance_minor/realism ride THAT response (GoalsPage reads list fields).
- FACT: hypothesis (a) holds only as DESIGN, not bug: free balance = last 3 FULL
  calendar months, current partial month excluded (goal_reads.py
  _FREE_BALANCE_MONTHS, D11). An income added today moves nothing until the month
  closes. Past-month income DOES recalc already.
- Resolution: product decision — see open questions. Default plan: explain the
  basis in UI copy (window months), do NOT change money-window semantics in this
  scope without PM sign-off.

## Constraints
- openapi.json + schema.d.ts regenerate together, one commit.
- Watermark discipline: dates in (last_materialized_on, today] get booked; the
  materializer never re-books; _next_due_on floors at max(watermark, today-1).
- Frozen mobile: no apps/mobile changes; @budget/shared changes only if they
  don't break the frozen client.
