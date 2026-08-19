import type { components } from '@budget/api-client';
import { describe, expect, it } from 'vitest';

import { pickDefaultAccount, sortForDisplay } from './accountLookup';

type AccountRead = components['schemas']['AccountRead'];
type TransactionRead = components['schemas']['TransactionRead'];

function account(overrides: Partial<AccountRead> & { id: string }): AccountRead {
  return {
    name: `Account ${overrides.id}`,
    type: 'card',
    currency: 'USD',
    starting_balance_minor: 0,
    balance_minor: 0,
    archived: false,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function transaction(accountId: string): TransactionRead {
  return {
    id: `tx-${accountId}`,
    account_id: accountId,
    amount_minor: 1000,
    base_amount_minor: null,
    base_currency: null,
    category_id: null,
    counter_account_id: null,
    counter_amount_minor: null,
    counter_currency: null,
    created_at: '2026-01-01T00:00:00Z',
    currency: 'USD',
    kind: 'expense',
    merchant: null,
    note: null,
    occurred_at: '2026-01-01',
    receipt_id: null,
    recurring_template_id: null,
    transfer_rate: null,
  };
}

describe('pickDefaultAccount', () => {
  const card = account({ id: 'a' });
  const cash = account({ id: 'b', type: 'cash' });

  it('prefers the account of the most recent cached operation', () => {
    // Two usable accounts, so the "only one" rule cannot produce this answer: the
    // cache is what decides.
    expect(pickDefaultAccount([card, cash], [transaction('b'), transaction('a')])).toBe('b');
  });

  it('skips a cached operation whose account is archived and keeps scanning', () => {
    const archived = account({ id: 'c', archived: true });
    expect(
      pickDefaultAccount([card, cash, archived], [transaction('c'), transaction('a')]),
    ).toBe('a');
  });

  it('falls back to the single non-archived account when the cache is empty', () => {
    expect(pickDefaultAccount([card, account({ id: 'z', archived: true })], [])).toBe('a');
  });

  it('returns nothing when several accounts are usable and nothing is cached', () => {
    // Cold start with no cache (no on-device persistence — OQ-M1): guessing between
    // two accounts is exactly the silent wrong-account write this scope prevents.
    expect(pickDefaultAccount([card, cash], [])).toBe('');
  });

  it('never returns an archived account, even as the only one there is', () => {
    expect(pickDefaultAccount([account({ id: 'c', archived: true })], [transaction('c')])).toBe(
      '',
    );
  });
});

describe('sortForDisplay', () => {
  it('puts archived accounts last, sorting by name inside each group', () => {
    const sorted = sortForDisplay(
      [
        account({ id: '1', name: 'Zeta', archived: true }),
        account({ id: '2', name: 'beta' }),
        account({ id: '3', name: 'Alpha', archived: true }),
        account({ id: '4', name: 'Alpha' }),
      ],
      'en',
    );
    expect(sorted.map((a) => a.id)).toEqual(['4', '2', '3', '1']);
  });
});
