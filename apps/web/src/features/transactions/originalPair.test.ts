import { describe, expect, it } from 'vitest';

import {
  describeOriginalPairError,
  isPairMode,
  migrateAmounts,
  spendCurrencyOptions,
  spendPrefill,
} from './originalPair';

describe('spendPrefill', () => {
  it('decodes each amount with ITS OWN currency (AM-5)', () => {
    // A 1000 JPY purchase on a EUR card charged 6.15 EUR. The exponents differ
    // (JPY 0, EUR 2), so a single shared exponent would print one of them 100x
    // wrong — the contrast this test exists for.
    const prefill = spendPrefill({
      amount_minor: 615,
      currency: 'EUR',
      original_amount_minor: 1000,
      original_currency: 'JPY',
    });
    expect(prefill).toEqual({ amount: '6.15', originalAmount: '1000', spendCurrency: 'JPY' });
  });

  it('starts an unpaired row on its account currency with no spent amount', () => {
    expect(
      spendPrefill({
        amount_minor: 1250,
        currency: 'USD',
        original_amount_minor: null,
        original_currency: null,
      }),
    ).toEqual({ amount: '12.50', originalAmount: '', spendCurrency: 'USD' });
  });
});

describe('isPairMode', () => {
  it('treats the account currency (and an unset control) as "no pair"', () => {
    expect(isPairMode('EUR', 'BYN')).toBe(true);
    expect(isPairMode('BYN', 'BYN')).toBe(false);
    expect(isPairMode(undefined, 'BYN')).toBe(false);
  });
});

describe('spendCurrencyOptions', () => {
  it('offers the account currency first, then the profile country, then accounts', () => {
    expect(
      spendCurrencyOptions({
        accountCurrency: 'BYN',
        profileCurrency: 'PLN',
        accountCurrencies: ['BYN', 'USD'],
        current: 'BYN',
      }),
    ).toEqual(['BYN', 'PLN', 'USD']);
  });

  it('keeps an out-of-set selection reachable and never duplicates', () => {
    // A JPY receipt: the code is not among the user's accounts or their country,
    // but it IS what this operation is denominated in.
    expect(
      spendCurrencyOptions({
        accountCurrency: 'EUR',
        profileCurrency: null,
        accountCurrencies: ['EUR', 'EUR'],
        current: 'JPY',
      }),
    ).toEqual(['EUR', 'JPY']);
  });
});

describe('migrateAmounts', () => {
  it('carries a typed amount into the SPENT field when a pair appears', () => {
    // The create flow: type 50, then say "that was euros". Leaving 50 behind in
    // the account-currency field would invent a charge nobody entered.
    expect(migrateAmounts({ amount: '50', originalAmount: '' }, false, true)).toEqual({
      amount: '',
      originalAmount: '50',
    });
  });

  it('keeps the CHARGE when the pair collapses, and only then the spent number', () => {
    // An edit that really was charged 165.00: that is what left the account.
    expect(migrateAmounts({ amount: '165.00', originalAmount: '50' }, true, false)).toEqual({
      amount: '165.00',
      originalAmount: '',
    });
    // Nothing was ever charged explicitly (server was going to convert): the one
    // number the user typed survives.
    expect(migrateAmounts({ amount: '', originalAmount: '50' }, true, false)).toEqual({
      amount: '50',
      originalAmount: '',
    });
  });

  it('touches nothing when the mode does not change', () => {
    const fields = { amount: '165.00', originalAmount: '50' };
    expect(migrateAmounts(fields, true, true)).toBe(fields);
    expect(migrateAmounts(fields, false, false)).toBe(fields);
  });
});

describe('describeOriginalPairError', () => {
  it('turns a missing rate into "type the charged amount", not a failure', () => {
    const described = describeOriginalPairError('FX_RATE_UNAVAILABLE');
    expect(described?.needsManualCharge).toBe(true);
    expect(described?.target).toBe('amount');
    // The copy explains the six stored pairs and asks for the bank's own number;
    // it is NOT the generic failure key.
    expect(described?.messageKey).toBe('txForm.chargeNoRateAhead');
  });

  it('leaves codes it does not own to the shared error layer', () => {
    expect(describeOriginalPairError('TRANSACTION_NOT_FOUND')).toBeNull();
    expect(describeOriginalPairError(undefined)).toBeNull();
  });
});
