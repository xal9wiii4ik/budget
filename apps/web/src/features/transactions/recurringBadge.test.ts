import type { components } from '@budget/api-client';
import { describe, expect, it } from 'vitest';

import { recurringBadge } from './recurringBadge';

type TransactionRead = components['schemas']['TransactionRead'];

function tx(overrides: Partial<TransactionRead>): TransactionRead {
  return {
    id: 'tx-1',
    occurred_at: '2026-08-15',
    amount_minor: 1250,
    recurring_template_id: null,
    base_amount_minor: null,
    base_currency: null,
    category_id: null,
    created_at: '2026-08-15T00:00:00Z',
    currency: 'USD',
    kind: 'expense',
    merchant: null,
    note: null,
    receipt_id: null,
    // goal-planner B1: NOT NULL on the wire, so the fixture states it explicitly —
    // an omitted key would make this object a DIFFERENT type from TransactionRead.
    goal_item_id: null,
    account_id: 'acc-1',
    counter_account_id: null,
    counter_amount_minor: null,
    counter_currency: null,
    transfer_rate: null,
    country: null,
    original_amount_minor: null,
    original_currency: null,
    original_rate: null,
    ...overrides,
  };
}

const index = new Map([['tpl-1', { name: 'Rent' }]]);

describe('recurringBadge', () => {
  it('resolves the template name from the cached index', () => {
    expect(recurringBadge(tx({ recurring_template_id: 'tpl-1' }), index)).toEqual({
      name: 'Rent',
    });
  });

  it('still returns a (name-less) badge for an id the index cannot resolve', () => {
    // The index is deliberately NON-EMPTY, so this arm is not accidentally the
    // same test as the empty-index one below: the id is genuinely a cache miss.
    expect(recurringBadge(tx({ recurring_template_id: 'tpl-gone' }), index)).toEqual({
      name: undefined,
    });
  });

  it('returns a name-less badge while the template list is unavailable (empty index)', () => {
    expect(recurringBadge(tx({ recurring_template_id: 'tpl-1' }), new Map())).toEqual({
      name: undefined,
    });
  });

  it('returns null — NO chip — for a row no template created', () => {
    // The contrast pair with the unresolvable arm above: a naive
    // `index.get(id) ?? null` returns null for both and loses the chip on a miss.
    expect(recurringBadge(tx({ recurring_template_id: null }), index)).toBeNull();
  });
});
