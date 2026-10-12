import { describe, expect, it } from 'vitest';

import type { DebtRead } from '../../data/debts';
import { debtDeadlineRows } from './debtDeadlines';

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
    due_on: '2026-10-20',
    note: null,
    repayments_count: 0,
    created_at: '2026-09-01T10:00:00Z',
    ...overrides,
  };
}

describe('debtDeadlineRows', () => {
  const today = '2026-10-12';

  it('includes both ends of the window and nothing outside it', () => {
    const rows = debtDeadlineRows(
      [
        debt({ id: 'due-today', due_on: '2026-10-12' }),
        debt({ id: 'last-day', due_on: '2026-11-11' }),
        debt({ id: 'day-after', due_on: '2026-11-12' }),
        // Yesterday is NOT in the window: the /debts row badges it "overdue",
        // and a widget called "coming up" must not claim it is coming.
        debt({ id: 'yesterday', due_on: '2026-10-11' }),
      ],
      today,
      30,
    );

    expect(rows.map((row) => row.debtId)).toEqual(['due-today', 'last-day']);
  });

  it('drops settled debts and debts with no deadline', () => {
    const rows = debtDeadlineRows(
      [
        // `status` is the SERVER's (remaining === 0): nothing is owed, so a date
        // on it is history rather than something to act on.
        debt({ id: 'settled', due_on: '2026-10-15', status: 'closed', remaining_minor: 0 }),
        debt({ id: 'no-deadline', due_on: null }),
      ],
      today,
      30,
    );

    expect(rows).toEqual([]);
  });

  it('orders by the due date, soonest first, and carries the figures verbatim', () => {
    const rows = debtDeadlineRows(
      [
        debt({ id: 'later', due_on: '2026-10-30' }),
        debt({
          id: 'sooner',
          due_on: '2026-10-14',
          direction: 'borrowed',
          currency: 'USD',
          remaining_minor: 12345,
        }),
      ],
      today,
      30,
    );

    expect(rows.map((row) => row.debtId)).toEqual(['sooner', 'later']);
    // No money is derived here: `remaining_minor` and the currency are copied.
    expect(rows[0]).toMatchObject({
      direction: 'borrowed',
      currency: 'USD',
      remainingMinor: 12345,
      dueOn: '2026-10-14',
    });
  });
});
