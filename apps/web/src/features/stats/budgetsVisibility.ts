import type { PeriodSelection } from './period';

/**
 * Visible only for a MONTH period, and then carrying that month.
 *
 * The month is part of the result, not re-derived by the caller: the section
 * follows the picker (a past month is a perfectly meaningful budget window —
 * `GET /limits?month=` takes one), so reading `currentMonth()` at the query site
 * would silently show August's budgets while the screen says April.
 */
export type BudgetsVisibility = { visible: true; month: string } | { visible: false };

/**
 * The WR-6 / Disagreement-1 gate: a limit is a CALENDAR-MONTH budget (D16), so a
 * quarter, a year or a custom range has no honest bar to draw. Rather than
 * summing three months of budget client-side (inventing a number the API never
 * returns) or showing one month's bar under a quarter label (a lie about what is
 * being measured), the section explains itself and points at `/categories`.
 */
export function budgetsVisibility(selection: PeriodSelection): BudgetsVisibility {
  if (selection.unit === 'month') return { visible: true, month: selection.month };
  return { visible: false };
}
