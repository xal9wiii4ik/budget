import { describe, expect, it } from 'vitest';

import type { DepositRead } from '../../data/deposits';
import { addDays, depositDeadlineRows, sortByAnchor } from './depositDeadlines';

function deposit(overrides: Partial<DepositRead> = {}): DepositRead {
  return {
    id: 'dep-1',
    name: 'Bank deposit',
    account_id: 'acc-deposit-1',
    currency: 'BYN',
    rate_percent: '10.95',
    capitalization: 'monthly',
    opened_on: '2025-08-01',
    term_end: '2026-09-01',
    tax_rate_percent: null,
    balance_minor: 500000,
    accrued_minor: 4200,
    accrued_after_tax_minor: null,
    accrued_override_minor: null,
    accrued_override_as_of: null,
    status: 'active',
    archived: false,
    created_at: '2026-08-01T10:00:00Z',
    ...overrides,
  };
}

describe('addDays', () => {
  it('crosses a month boundary', () => {
    expect(addDays('2026-08-27', 30)).toBe('2026-09-26');
  });

  it('handles the leap day', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });
});

describe('depositDeadlineRows', () => {
  const today = '2026-08-27';

  it('includes both ends of the window and nothing outside it', () => {
    const rows = depositDeadlineRows(
      [
        deposit({ id: 'ends-today', term_end: '2026-08-27' }),
        deposit({ id: 'last-day', term_end: '2026-09-26' }),
        deposit({ id: 'day-after', term_end: '2026-09-27' }),
        deposit({ id: 'yesterday', term_end: '2026-08-26' }),
      ],
      today,
      30,
    );

    // Both boundaries are inclusive: a deposit maturing TODAY is the most urgent
    // row there is, and one maturing on the horizon's last day is still inside
    // it. Yesterday's is past — the /deposits screen badges it "matured".
    expect(rows.map((row) => row.depositId)).toEqual(['ends-today', 'last-day']);
  });

  it('drops open-ended and archived deposits', () => {
    const rows = depositDeadlineRows(
      [
        deposit({ id: 'open-ended', term_end: null }),
        deposit({ id: 'closed', term_end: '2026-09-01', archived: true }),
      ],
      today,
      30,
    );

    expect(rows).toEqual([]);
  });

  it('orders by the term date, soonest first', () => {
    const rows = depositDeadlineRows(
      [
        deposit({ id: 'later', term_end: '2026-09-10' }),
        deposit({ id: 'sooner', term_end: '2026-08-30' }),
      ],
      today,
      30,
    );

    expect(rows.map((row) => row.depositId)).toEqual(['sooner', 'later']);
  });
});

describe('sortByAnchor', () => {
  it('interleaves two sources by date and keeps a same-day tie in source order', () => {
    const merged = sortByAnchor([
      { anchor: '2026-09-01', id: 'goal-a' },
      { anchor: '2026-09-05', id: 'goal-b' },
      { anchor: '2026-08-30', id: 'deposit-a' },
      { anchor: '2026-09-01', id: 'deposit-b' },
    ]);

    expect(merged.map((row) => row.id)).toEqual([
      'deposit-a',
      // The tie keeps the order it was handed in — the ES2019 stable sort — so
      // rows do not swap places between renders.
      'goal-a',
      'deposit-b',
      'goal-b',
    ]);
  });

  it('puts an anchorless row last instead of dropping it', () => {
    const merged = sortByAnchor([
      { anchor: null, id: 'undated' },
      { anchor: '2026-09-01', id: 'dated' },
    ]);

    expect(merged.map((row) => row.id)).toEqual(['dated', 'undated']);
  });
});
