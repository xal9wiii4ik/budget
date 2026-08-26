// Did this transaction write move money inside somebody's PLAN? (goal-planner W2)
//
// Until W2 a transaction mutation invalidated `['goals','list']` only — the cards
// read the last three full months of spending, and nothing else in the goals
// family depended on a transaction. Attaching an operation to a plan item changed
// that: `paid_minor` on the NODE, on every ANCESTOR of it, on the goal, and the
// "still to find" figure in the deadline widget are all server rollups over
// exactly these rows (architecture §4). Miss the invalidation and "paid" lies
// until F5 — the risk this scope's plan names first (qa TC-4).
//
// The trigger is a pure two-value question, and it is deliberately NOT "was
// anything about the row different": an amount or a date edit on an ATTACHED
// operation moves the rollup just as much as attaching one does.
//
//   before  after   -> refresh the plan family?
//   null    null      no   — the row never touched a plan (today's behaviour)
//   null    id        yes  — it was just attached
//   id      null       yes  — it was detached (or the row was deleted)
//   id      same id    yes  — an attached row moved money, date or account
//   id      other id   yes  — it moved between nodes; BOTH rollups changed
//
// `after` is `null` for a delete: the row is gone, so nothing can still be
// attached to it.
//
// Kept here, pure and free of TanStack Query, so the rule is testable without a
// QueryClient — the `categoryLookup.ts` precedent in this folder.
export function touchesGoalPlan(
  before: string | null,
  after: string | null,
): boolean {
  return before !== null || after !== null;
}
