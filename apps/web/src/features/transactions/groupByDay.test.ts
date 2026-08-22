import { describe, expect, it } from 'vitest';
import type { components } from '@budget/api-client';

import { groupByDay } from './groupByDay';

type TransactionRead = components['schemas']['TransactionRead'];

function tx(id: string, occurred_at: string): TransactionRead {
  return {
    id,
    occurred_at,
    amount_minor: 100,
    recurring_template_id: null,
    base_amount_minor: null,
    base_currency: null,
    category_id: null,
    created_at: `${occurred_at}T00:00:00Z`,
    currency: 'USD',
    kind: 'expense',
    merchant: null,
    note: null,
    receipt_id: null,
    account_id: 'acc-1',
    counter_account_id: null,
    counter_amount_minor: null,
    counter_currency: null,
    transfer_rate: null,
    country: null,
    original_amount_minor: null,
    original_currency: null,
    original_rate: null,
  };
}

describe('groupByDay', () => {
  it('buckets contiguous same-day rows and preserves DESC order across a month boundary', () => {
    // occurred_at-DESC input crossing Aug -> Jul, with two rows on Jul 31.
    const input = [
      tx('a', '2026-08-01'),
      tx('b', '2026-07-31'),
      tx('c', '2026-07-31'),
      tx('d', '2026-07-30'),
    ];

    const groups = groupByDay(input);

    expect(groups.map((g) => g.date)).toEqual(['2026-08-01', '2026-07-31', '2026-07-30']);
    expect(groups[1].items.map((t) => t.id)).toEqual(['b', 'c']);
    expect(groups[0].items).toHaveLength(1);
    expect(groups[2].items).toHaveLength(1);
  });
});
