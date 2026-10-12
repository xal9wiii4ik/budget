// How the /debts screen reads one archived-inclusive list: three groups, and
// what each row's state is. Pure and tested — the split and the order are
// exactly the kind of rule a JSX diff cannot show, and getting the overdue
// predicate wrong would badge a debt that is not late (or, worse, stay silent
// about one that is).
//
// `GET /debts` answers ALL debts with no `?status=` (architecture: the
// archived-inclusive style), so the grouping is the view's job. It computes no
// money: `status`, `remaining_minor` and `closed_on` are server fields.
import type { DebtRead } from '../../data/debts';

export interface DebtGroups {
  /** Open, direction `lent` — "Мне должны". */
  lent: DebtRead[];
  /** Open, direction `borrowed` — "Я должен". */
  borrowed: DebtRead[];
  /** Closed, both directions — the quiet, collapsed section. */
  closed: DebtRead[];
}

/**
 * Open debts by direction, closed debts last.
 *
 * Open rows are ordered by the date they are DUE (soonest first) because that is
 * the only thing on the row anybody has to act on; a debt with no due date has
 * nothing to be ordered by and sorts after the dated ones, keeping its arrival
 * order. Closed rows are ordered by `closed_on` DESCENDING — the most recently
 * settled debt is the one a reader is looking for.
 *
 * A stable sort (the ES2019 guarantee) is what keeps ties in server order, so
 * rows do not swap places between renders.
 */
export function groupDebts(debts: DebtRead[]): DebtGroups {
  const open = debts.filter((debt) => debt.status === 'open');
  return {
    lent: byDueDate(open.filter((debt) => debt.direction === 'lent')),
    borrowed: byDueDate(open.filter((debt) => debt.direction === 'borrowed')),
    closed: byClosedOnDesc(debts.filter((debt) => debt.status === 'closed')),
  };
}

function byDueDate(debts: DebtRead[]): DebtRead[] {
  return [...debts].sort((a, b) => {
    if (a.due_on === b.due_on) return 0;
    // An undated debt cannot be placed on a timeline; it goes last rather than
    // being hidden or pretending to be urgent.
    if (a.due_on === null) return 1;
    if (b.due_on === null) return -1;
    return a.due_on < b.due_on ? -1 : 1;
  });
}

function byClosedOnDesc(debts: DebtRead[]): DebtRead[] {
  return [...debts].sort((a, b) => {
    if (a.closed_on === b.closed_on) return 0;
    if (a.closed_on === null) return 1;
    if (b.closed_on === null) return -1;
    return a.closed_on > b.closed_on ? -1 : 1;
  });
}

/** Which text badges a row carries. Colour is never the sentence. */
export type DebtBadge = 'overdue' | 'closed';

export interface DebtRowState {
  badges: DebtBadge[];
  /**
   * Past its due date and still owed. Drives the row's warning styling — by
   * MEANING (a date that has passed), never by the sign of a number.
   */
  isOverdue: boolean;
  /** Whether "record a repayment" makes sense: a closed debt owes nothing. */
  canRecordRepayment: boolean;
}

/**
 * One row's state, given the day to compare against.
 *
 * `today` is handed in rather than read: the caller passes `todayApiDateUtc()`
 * (the widget's rule — the SERVER decides `status` and the digest window in UTC,
 * and a local-midnight compare disagrees with it for hours in any offset zone),
 * and a pure function is what makes the boundary testable.
 *
 * A closed debt is never overdue: nothing is owed, so a date in the past is
 * merely when it happened.
 */
export function debtRowState(debt: DebtRead, today: string): DebtRowState {
  const closed = debt.status === 'closed';
  const isOverdue = !closed && debt.due_on !== null && debt.due_on < today;
  const badges: DebtBadge[] = [];
  if (isOverdue) badges.push('overdue');
  if (closed) badges.push('closed');
  return { badges, isOverdue, canRecordRepayment: !closed };
}
