// Which months the server's free balance was computed over (architecture C).
//
// The complaint was never a math bug: "over the last 3 full months" does not say
// WHICH three, so income booked this month looks ignored. The API deliberately
// exposes no window boundaries — deriving the label from today's date is pure
// calendar labelling, not money arithmetic (the invariant bans client MONEY math),
// so the window is re-derived here, once, from the same rule the server uses.
//
// The rule, verbatim from the server: `services/goal_reads.py` iterates
// `offset in range(-3, 0)` from `today.replace(day=1)`, and `routers/goals.py`
// makes `today` UTC. So the window is [current_month - 3, current_month - 1],
// inclusive, and its basis is UTC — hence `getUTC*` here rather than
// `currentMonth()`, which reads LOCAL components and would name the wrong window
// for the hours around a month boundary in any zone offset from UTC.
import { monthParam, shiftMonth } from '@budget/shared';

export interface FreeBalanceWindow {
  /** Oldest month of the window, "YYYY-MM". */
  fromMonth: string;
  /** Newest month of the window, "YYYY-MM" — the last FULL month. */
  toMonth: string;
}

/**
 * The three full calendar months before `now`'s UTC month.
 * `new Date(Date.UTC(2026, 0, 1))` -> `{ fromMonth: '2025-10', toMonth: '2025-12' }`.
 *
 * Returns keys, not labels: the caller formats them with the user's locale.
 */
export function freeBalanceWindow(now: Date): FreeBalanceWindow {
  // `getUTCMonth()` is 0-based, `monthParam` is 1-based.
  const currentMonthUtc = monthParam(now.getUTCFullYear(), now.getUTCMonth() + 1);
  return {
    fromMonth: shiftMonth(currentMonthUtc, -3),
    toMonth: shiftMonth(currentMonthUtc, -1),
  };
}
