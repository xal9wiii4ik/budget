// The "soon" mark on a plan row (mobile-catchup-3, line C).
//
// A node is marked when the date it is ABOUT — its reminder if it has one, else
// its effective (possibly inherited) deadline — falls inside the next 30 days.
// Same horizon as the deadlines widget's `days=30`, so a row marked here is a row
// the widget on the transactions tab is showing.
//
// Dates only, never money. Two "YYYY-MM-DD" strings compare as dates, so nothing
// is parsed at compare time; the ONE computation is the horizon, built from
// calendar components (`new Date(y, m - 1, d + 30)` — the house `dates.ts`
// pattern, which normalises month and leap rollover for us).
//
// UTC, because the SERVER decided these dates in UTC: a local-midnight compare
// marks the wrong row for hours in any offset zone.
import { toApiDate } from '@budget/shared';

export const SOON_DAYS = 30;

/** The last date still counted as "soon", given today's API date. */
export function soonHorizon(todayUtc: string, days: number = SOON_DAYS): string {
  const [year, month, day] = todayUtc.split('-').map(Number);
  return toApiDate(new Date(year, month - 1, day + days));
}

/**
 * Is `anchor` inside [today, horizon]?
 *
 * A date already PAST is not "soon" — it is late, which the row says with the
 * date itself; inventing a second meaning for the same mark would make it
 * useless. `null` (no date at all) is never soon.
 */
export function isSoon(anchor: string | null, todayUtc: string, horizon: string): boolean {
  if (anchor === null) return false;
  return anchor >= todayUtc && anchor <= horizon;
}
