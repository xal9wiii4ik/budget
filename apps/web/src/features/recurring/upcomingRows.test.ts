import { describe, expect, it } from 'vitest';

import type { UpcomingChargeRead } from '../../data/recurring';
import { upcomingRows } from './upcomingRows';

function charge(dueOn: string, name = 'Rent'): UpcomingChargeRead {
  return {
    account_id: 'acc-1',
    amount_minor: 5_000_000,
    category_id: null,
    currency: 'RUB',
    due_on: dueOn,
    kind: 'expense',
    name,
    template_id: `tpl-${dueOn}`,
  };
}

describe('upcomingRows', () => {
  it('caps the list and reports exactly how many rows were left out', () => {
    const items = ['2026-08-22', '2026-08-23', '2026-08-24', '2026-08-25'].map((d) => charge(d));

    // Exactly at the cap: nothing is hidden and nothing is dropped (the off-by-one).
    const exact = upcomingRows(items, { max: 4, today: '2026-08-22' });
    expect(exact.rows).toHaveLength(4);
    expect(exact.hiddenCount).toBe(0);

    // One over: the head is kept, in the server's order, and the remainder counted.
    const capped = upcomingRows(items, { max: 3, today: '2026-08-22' });
    expect(capped.rows.map((row) => row.charge.due_on)).toEqual([
      '2026-08-22',
      '2026-08-23',
      '2026-08-24',
    ]);
    expect(capped.hiddenCount).toBe(1);

    // Fewer rows than the cap can never report a negative remainder.
    expect(upcomingRows(items.slice(0, 1), { max: 5, today: '2026-08-22' }).hiddenCount).toBe(0);
  });

  it('flags isToday only for due_on === today, not for the days on either side', () => {
    const { rows } = upcomingRows(
      [charge('2026-08-21'), charge('2026-08-22'), charge('2026-08-23')],
      { max: 5, today: '2026-08-22' },
    );
    expect(rows.map((row) => row.isToday)).toEqual([false, true, false]);
  });
});
