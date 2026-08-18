# Task (verbatim PM scope brief, 2026-08-18)

SCOPE (id: `recurring-and-limits`, roadmap 5.3 + 5.4, web + backend, mobile FROZEN):

- 5.3 Recurring operations: recurring transaction templates (amount/currency/category/kind/merchant?/note, periodicity — decompose the grammar: monthly-on-day-N minimum, weekly?, custom?; end conditions), auto-materialization by the existing APScheduler (idempotent catch-up per the fx-jobs precedent — missed days materialize once; decide the materialized-transaction relationship to its template: FK? snapshot semantics for multi-currency per stage-3 rules), CRUD API + web UI (list/create/edit/pause/delete templates; materialized rows visibly attributable to their template in the tx list).
- 5.4 Category limits: monthly budget per category (base currency), CRUD (likely on the category or a separate limits table — architect decides), "spent X of Y" indication in stats/categories screens using the stage-4 aggregates (spent = base-currency snapshot semantics, honest unconverted handling), over-limit visual state. NO push notifications (that's 5.2, not in scope).

Polish backlog items that MAY fold in where they touch the same code (senior-lead call per item, recorded): network-unreachable alert/Retry on /stats and /goals; backdrop-click discard confirmation on modals; ru double-terminator in stats empty-state.

Expected tiers: migrations + scheduler materialization job + template CRUD = FULL (money + DDL + scheduler); limits CRUD = senior-lead call; web UI = STANDARD.

Team: architect, backend-engineer, frontend-engineer, qa-engineer.
Env: PG 5443 via TEST_DATABASE_URL, API 8010, FX_SCHEDULER_ENABLED=false on test servers (decide the analogous flag for the new materialization job — same pattern).

Output per scope mode into .tasks/recurring-and-limits/: architecture.md, plan.md, plan-web.md (ordered subtasks, tiers, dependencies), qa-checklist.md, grooming-review.md. Do NOT start implementation.
