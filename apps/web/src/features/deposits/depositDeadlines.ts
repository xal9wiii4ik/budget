// Which deposits end soon, for the /transactions deadline widget (architecture:
// "Напоминание о конце срока — эндпоинт НЕ делаем"). The list is already in the
// client's cache, so the window is applied HERE — and it is applied to DATES,
// which is the one computation this scope allows the browser to do. No money is
// derived: `balance_minor` is carried through verbatim for display.
//
// Pure and unit-tested, because the two things that silently rot are exactly the
// ones a JSX diff cannot show: which rows fall inside the horizon (the two
// boundaries are INCLUSIVE — a deposit ending today is the most urgent row there
// is, and a deposit ending on the last day of the window belongs in it), and
// what happens to a row with no term at all.
import type { DepositRead } from '../../data/deposits';

export interface DepositDeadlineRow {
  depositId: string;
  name: string;
  /** "YYYY-MM-DD" — the day the term ends. Never null: that is the filter. */
  termEnd: string;
  currency: string;
  /** The SERVER's body figure, carried through for display only. */
  balanceMinor: number;
}

/**
 * `days` after `today`, as an api date. UTC arithmetic on a date-only string:
 * `new Date('2026-08-27')` is parsed as UTC midnight by spec, and adding days in
 * UTC never lands on a DST-shortened local day.
 */
export function addDays(today: string, days: number): string {
  const start = new Date(`${today}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() + days);
  return start.toISOString().slice(0, 10);
}

/**
 * The deposits whose term ends within `[today, today + days]`, soonest first.
 *
 * Archived deposits are out: an archived deposit is a closed record, and its
 * term ending changes nothing anybody has to act on. Open-ended deposits
 * (`term_end === null`, a legal savings account) are out for the same reason —
 * they have no date to be due on.
 *
 * "YYYY-MM-DD" strings compare as dates under `<=`, so nothing is parsed here
 * and no timezone can shift a boundary.
 */
export function depositDeadlineRows(
  deposits: DepositRead[],
  today: string,
  days: number,
): DepositDeadlineRow[] {
  const horizon = addDays(today, days);
  return deposits
    .filter(
      (deposit) =>
        !deposit.archived &&
        deposit.term_end !== null &&
        deposit.term_end >= today &&
        deposit.term_end <= horizon,
    )
    .map((deposit) => ({
      depositId: deposit.id,
      // `term_end` is non-null past the filter above; re-stated rather than
      // asserted so no non-null assertion is needed to satisfy strict mode.
      termEnd: deposit.term_end ?? today,
      name: deposit.name,
      currency: deposit.currency,
      balanceMinor: deposit.balance_minor,
    }))
    .sort((a, b) => (a.termEnd < b.termEnd ? -1 : a.termEnd > b.termEnd ? 1 : 0));
}

/**
 * Two already-sorted deadline lists rendered as one, ordered by the date each
 * row is ABOUT. `null` anchors sort LAST: a row the server sent with neither a
 * reminder nor a deadline cannot be placed on a timeline, and dropping it would
 * hide a plan item instead of merely mis-ordering it.
 *
 * A stable sort (the ES2019 guarantee) is what keeps ties in source order, so a
 * goal item and a deposit that fall on the same day do not swap places on every
 * re-render.
 */
export function sortByAnchor<T extends { anchor: string | null }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.anchor === b.anchor) return 0;
    if (a.anchor === null) return 1;
    if (b.anchor === null) return -1;
    return a.anchor < b.anchor ? -1 : 1;
  });
}
