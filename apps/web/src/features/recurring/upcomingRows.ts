// What the /transactions upcoming widget actually renders (recurring-dates-and-income
// W1): the first few of the server's rows, each flagged for "due today".
//
// Two decisions live here rather than in the component, both so they are testable
// without a clock stub or a DOM:
//
//   - The CAP is render-side truncation of an already-sorted list (B5 sorts by
//     `(due_on, created_at, id)`), never a re-sort and never a filter: the widget
//     shows the head of what the server said and links to /recurring for the rest.
//   - "TODAY" is a lexicographic compare of two "YYYY-MM-DD" strings, which for
//     this format IS a date compare. `today` is INJECTED, and the caller passes
//     `todayApiDateUtc()` — the server decides `due_on` in UTC (`_today()`), so a
//     local-midnight compare would badge the wrong row for hours around the
//     boundary in any offset zone.
//
// No totals, no grouping: summing rows would be cross-currency money arithmetic,
// which the client never does.
import type { UpcomingChargeRead } from '../../data/recurring';

export interface UpcomingRow {
  charge: UpcomingChargeRead;
  /** `due_on` is today: the charge is owed today and has not been booked yet. */
  isToday: boolean;
}

export interface UpcomingRows {
  rows: UpcomingRow[];
  /** How many of `items` did not fit under the cap (0 when everything fits). */
  hiddenCount: number;
}

export function upcomingRows(
  items: readonly UpcomingChargeRead[],
  { max, today }: { max: number; today: string },
): UpcomingRows {
  return {
    rows: items.slice(0, max).map((charge) => ({ charge, isToday: charge.due_on === today })),
    hiddenCount: Math.max(items.length - max, 0),
  };
}
