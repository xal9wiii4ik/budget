import { formatMoney } from '@budget/shared';
import type { components } from '@budget/api-client';
import { describe, expect, it } from 'vitest';

import { baseEquivalent } from './rowDisplay';

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
    account_id: 'acc-1',
    counter_account_id: null,
    counter_amount_minor: null,
    counter_currency: null,
    transfer_rate: null,
    ...overrides,
  };
}

describe('baseEquivalent', () => {
  it('returns the snapshot pair for a foreign row and decodes it with the PAIR currency (AM-5)', () => {
    // Base currency JPY (exponent 0), a USD row whose stored snapshot is 5000 yen.
    const row = tx({ currency: 'USD', base_amount_minor: 5000, base_currency: 'JPY' });
    const equivalent = baseEquivalent(row, 'JPY');
    expect(equivalent).toEqual({ minor: 5000, currency: 'JPY' });
    if (equivalent === null) throw new Error('expected an equivalent');

    // The rendered line uses the pair's own currency...
    const rendered = formatMoney(equivalent.minor, equivalent.currency, { locale: 'en-US' });
    expect(rendered).toContain('5,000');

    // ...and the contrast arm: decoding the same minor value with the ROW's
    // currency (the `?? fallback` mistake AM-5 forbids) is off by 100x.
    const wrongDecode = formatMoney(5000, row.currency, { locale: 'en-US' });
    expect(wrongDecode).toContain('50.00');
    expect(rendered).not.toBe(wrongDecode);
  });

  it('hides a stale-base snapshot (pair currency != summary currency)', () => {
    expect(
      baseEquivalent(
        tx({ currency: 'USD', base_amount_minor: 9000, base_currency: 'RUB' }),
        'EUR',
      ),
    ).toBeNull();
  });

  it('returns null for a row already in the summary currency', () => {
    expect(baseEquivalent(tx({ currency: 'RUB' }), 'RUB')).toBeNull();
  });

  it('returns null for a foreign row with no snapshot (no rate existed)', () => {
    expect(baseEquivalent(tx({ currency: 'USD' }), 'RUB')).toBeNull();
  });
});
