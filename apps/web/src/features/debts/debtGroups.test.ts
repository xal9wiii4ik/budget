import { describe, expect, it } from 'vitest';

import type { DebtRead } from '../../data/debts';
import { debtRowState, groupDebts } from './debtGroups';

function debt(overrides: Partial<DebtRead> = {}): DebtRead {
  return {
    id: 'debt-1',
    direction: 'lent',
    counterparty: 'Иван',
    currency: 'BYN',
    principal_minor: 50000,
    repaid_minor: 0,
    remaining_minor: 50000,
    status: 'open',
    closed_on: null,
    opened_on: '2026-09-01',
    account_id: 'acc-1',
    account_amount_minor: 50000,
    account_currency: 'BYN',
    due_on: null,
    note: null,
    repayments_count: 0,
    created_at: '2026-09-01T10:00:00Z',
    ...overrides,
  };
}

const settled = (overrides: Partial<DebtRead> = {}): DebtRead =>
  debt({ status: 'closed', remaining_minor: 0, repaid_minor: 50000, ...overrides });

describe('groupDebts', () => {
  it('splits open debts by direction and puts every settled one aside', () => {
    const groups = groupDebts([
      debt({ id: 'they-owe' }),
      debt({ id: 'i-owe', direction: 'borrowed' }),
      // A settled debt leaves its direction group entirely: the two open groups
      // answer "who owes what", which a closed debt no longer takes part in.
      settled({ id: 'settled-lent', closed_on: '2026-10-01' }),
      settled({ id: 'settled-borrowed', direction: 'borrowed', closed_on: '2026-10-05' }),
    ]);

    expect(groups.lent.map((row) => row.id)).toEqual(['they-owe']);
    expect(groups.borrowed.map((row) => row.id)).toEqual(['i-owe']);
    expect(groups.closed.map((row) => row.id)).toEqual(['settled-borrowed', 'settled-lent']);
  });

  it('orders open debts by due date and sends the undated ones last', () => {
    const groups = groupDebts([
      debt({ id: 'undated', due_on: null }),
      debt({ id: 'later', due_on: '2026-12-01' }),
      debt({ id: 'sooner', due_on: '2026-10-20' }),
    ]);

    // A debt with no deadline cannot be placed on the timeline, so it goes last
    // rather than being hidden or reading as the most urgent row.
    expect(groups.lent.map((row) => row.id)).toEqual(['sooner', 'later', 'undated']);
  });

  it('orders settled debts by the day they were settled, most recent first', () => {
    const groups = groupDebts([
      settled({ id: 'old', closed_on: '2026-01-15' }),
      settled({ id: 'recent', closed_on: '2026-10-02' }),
    ]);

    expect(groups.closed.map((row) => row.id)).toEqual(['recent', 'old']);
  });
});

describe('debtRowState', () => {
  const today = '2026-10-12';

  it('badges a debt whose deadline has passed', () => {
    const state = debtRowState(debt({ due_on: '2026-10-11' }), today);

    expect(state).toEqual({
      badges: ['overdue'],
      isOverdue: true,
      canRecordRepayment: true,
    });
  });

  it('does not badge a debt due today or later', () => {
    expect(debtRowState(debt({ due_on: today }), today).isOverdue).toBe(false);
    expect(debtRowState(debt({ due_on: '2026-10-13' }), today).isOverdue).toBe(false);
    expect(debtRowState(debt({ due_on: null }), today).badges).toEqual([]);
  });

  it('never calls a settled debt overdue, and offers it no repayment', () => {
    // The CONTRAST with the first case: the very same past deadline, on a debt
    // that owes nothing. Nothing is late when nothing is owed — and a repayment
    // on it would only earn the server's EXCEEDS_REMAINING refusal.
    const state = debtRowState(settled({ due_on: '2026-10-11' }), today);

    expect(state).toEqual({
      badges: ['closed'],
      isOverdue: false,
      canRecordRepayment: false,
    });
  });
});
