import { describe, expect, it } from 'vitest';
import type { MultiCurrencyTransactionFormValues } from '@budget/shared';

import { buildCreateBody } from './createBody';

// Base currency is RUB throughout; the form holds a foreign (USD) amount. Moved
// from apps/web with the builder (mobile-catchup-2).
const values: MultiCurrencyTransactionFormValues = {
  account_id: 'acc-1',
  amount: 1250,
  currency: 'USD',
  base_amount_minor: 9000,
  kind: 'expense',
  category_id: 'cat-1',
  occurred_at: '2026-08-15',
  note: '',
  // Rendered by some callers, added by them; buildCreateBody deliberately
  // ignores it, so a plain create body stays exactly what it was.
  merchant: '',
};

describe('buildCreateBody', () => {
  it('sends base_amount_minor when the user edited the converted field', () => {
    const body = buildCreateBody(values, 'RUB', true);
    expect(body.base_amount_minor).toBe(9000);
    // The account travels; the currency does NOT — the server stamps it from the
    // account (§4), and sending a second copy could only ever 422.
    expect(body.account_id).toBe('acc-1');
    expect('currency' in body).toBe(false);
  });

  it('OMITS an autofilled-but-untouched converted value (server recomputes)', () => {
    // Same parsed value, only the edited flag differs from the case above — the
    // contrast that pins Disagreement 1: a preview echo is never stored as an
    // override.
    const body = buildCreateBody(values, 'RUB', false);
    expect('base_amount_minor' in body).toBe(false);
  });

  it('sends the original pair whole, and lets the server compute a blank charge', () => {
    // 50.00 EUR spent on a BYN account, charged amount left empty: the body must
    // carry BOTH pair members (half of one is a 422) and NO amount_minor at all
    // (sending null would be rejected — the column is NOT NULL).
    const body = buildCreateBody(
      {
        ...values,
        currency: 'BYN',
        amount: null,
        base_amount_minor: null,
        original_amount_minor: 5000,
        original_currency: 'EUR',
        country: 'DE',
      },
      'RUB',
      false,
    );
    expect('amount_minor' in body).toBe(false);
    expect(body.original_amount_minor).toBe(5000);
    expect(body.original_currency).toBe('EUR');
    expect(body.country).toBe('DE');
  });

  it('sends no original keys and no country for a plain single-currency create', () => {
    const body = buildCreateBody(values, 'RUB', false);
    expect(body.amount_minor).toBe(1250);
    expect('original_amount_minor' in body).toBe(false);
    expect('original_currency' in body).toBe(false);
    expect('country' in body).toBe(false);
  });

  it('never sends base_amount_minor for a base-currency row', () => {
    // Even with an edited flag and a stale parsed value: a base-currency row's
    // amount_minor IS its base amount (the server 422s a second copy).
    const body = buildCreateBody({ ...values, currency: 'RUB' }, 'RUB', true);
    expect('base_amount_minor' in body).toBe(false);
  });
});
