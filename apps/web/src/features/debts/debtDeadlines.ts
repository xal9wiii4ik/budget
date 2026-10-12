// Which debts are due soon, for the /transactions "coming up" widget. The TWIN of
// `features/deposits/depositDeadlines.ts`, deliberately: the architecture adds no
// `/debts/upcoming` endpoint ("веб — клиентский фильтр кешированного списка
// (близнец depositDeadlines)"), because the list is already in the client's cache
// and the window is a DATE filter — the one computation this project lets the
// browser do. No money is derived: `remaining_minor` is carried verbatim.
//
// Pure and unit-tested for the same two reasons as its twin: which rows fall
// inside the horizon (both boundaries INCLUSIVE — a debt due TODAY is the most
// urgent row there is, and one due on the last day of the window belongs in it),
// and what happens to a row with no due date at all.
import { addDays } from '../deposits/depositDeadlines';
import type { DebtDirection, DebtRead } from '../../data/debts';

export interface DebtDeadlineRow {
  debtId: string;
  /** Free user text — never translated. */
  counterparty: string;
  direction: DebtDirection;
  /** "YYYY-MM-DD" — the day it is due. Never null: that is the filter. */
  dueOn: string;
  currency: string;
  /** The SERVER's remaining figure, carried through for display only. */
  remainingMinor: number;
}

/**
 * The OPEN debts whose `due_on` falls within `[today, today + days]`, soonest
 * first.
 *
 * Closed debts are out: `status === 'closed'` means nothing is owed any more, so
 * a date on it is history rather than something to act on. A debt with no
 * `due_on` is out for the plainer reason that it has no date to be due on —
 * "вернуть до" is optional by contract and most informal debts have none.
 *
 * `status` is a SERVER field (`remaining_minor === 0`), never recomputed here.
 * "YYYY-MM-DD" strings compare as dates under `<=`, so nothing is parsed and no
 * timezone can shift a boundary.
 */
export function debtDeadlineRows(
  debts: DebtRead[],
  today: string,
  days: number,
): DebtDeadlineRow[] {
  const horizon = addDays(today, days);
  return debts
    .filter(
      (debt) =>
        debt.status === 'open' &&
        debt.due_on !== null &&
        debt.due_on >= today &&
        debt.due_on <= horizon,
    )
    .map((debt) => ({
      debtId: debt.id,
      counterparty: debt.counterparty,
      direction: debt.direction,
      // Non-null past the filter above; re-stated rather than asserted so strict
      // mode needs no non-null assertion.
      dueOn: debt.due_on ?? today,
      currency: debt.currency,
      remainingMinor: debt.remaining_minor,
    }))
    .sort((a, b) => (a.dueOn < b.dueOn ? -1 : a.dueOn > b.dueOn ? 1 : 0));
}
