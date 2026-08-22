import { formatMoney } from '@budget/shared';
import type { components } from '@budget/api-client';
import { describe, expect, it } from 'vitest';

import { baseEquivalent, primaryAmount, rowTitle } from './rowDisplay';

type CategoryRead = components['schemas']['CategoryRead'];
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
    country: null,
    original_amount_minor: null,
    original_currency: null,
    original_rate: null,
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

describe('primaryAmount', () => {
  it('leads with what was SPENT and shows the charge as the second line', () => {
    // 50.00 EUR spent on a BYN card that was charged 165.00 BYN, in a RUB month:
    // the "≈ base" line is dropped so the row never carries three amounts.
    const row = tx({
      currency: 'BYN',
      amount_minor: 16500,
      original_amount_minor: 5000,
      original_currency: 'EUR',
      base_amount_minor: 480000,
      base_currency: 'RUB',
    });
    expect(primaryAmount(row, 'RUB')).toEqual({
      primary: { minor: 5000, currency: 'EUR' },
      secondary: { minor: 16500, currency: 'BYN', kind: 'charged' },
    });
  });

  it('keeps the shipped amount + "≈ base" pair when there is no spent pair', () => {
    const row = tx({ currency: 'USD', amount_minor: 1250, base_amount_minor: 9000, base_currency: 'RUB' });
    expect(primaryAmount(row, 'RUB')).toEqual({
      primary: { minor: 1250, currency: 'USD' },
      secondary: { minor: 9000, currency: 'RUB', kind: 'base' },
    });
    // No summary currency loaded yet: the row still renders its own amount, and
    // never guesses whether a snapshot is stale.
    expect(primaryAmount(row, undefined).secondary).toBeNull();
  });
});

describe('rowTitle', () => {
  const category: CategoryRead = {
    id: 'cat-1',
    name: 'Groceries',
    kind: 'expense',
    icon: null,
    color: null,
    archived: false,
    is_system: false,
  };

  // The two fallbacks are LABELS the caller translates; the sentinels below make
  // it visible which of them a given row lands on.
  const labels = { uncategorized: '<none>', unknownCategory: '<unknown>' };

  it('prefers the name the user gave the operation', () => {
    expect(
      rowTitle(tx({ merchant: 'Corner Shop', category_id: 'cat-1' }), category, labels),
    ).toBe('Corner Shop');
  });

  it('falls back to the category, then to the uncategorized label', () => {
    expect(rowTitle(tx({ category_id: 'cat-1' }), category, labels)).toBe('Groceries');
    expect(rowTitle(tx({ category_id: null }), undefined, labels)).toBe('<none>');
    // A row that names a category the loaded index has not got is a DIFFERENT
    // state from having none at all, and says so.
    expect(rowTitle(tx({ category_id: 'cat-9' }), undefined, labels)).toBe('<unknown>');
  });
});
