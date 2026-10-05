import { todayApiDate } from '@budget/shared';
import type { components } from '@budget/api-client';
import { describe, expect, it } from 'vitest';

import {
  buildConfirmDefaults,
  formatItemAmount,
  pickReceiptAccount,
  receiptCurrencyMismatch,
} from './confirmDefaults';

type AccountRead = components['schemas']['AccountRead'];
type CategoryRead = components['schemas']['CategoryRead'];
type ParsedReceiptRead = components['schemas']['ParsedReceiptRead'];

function account(overrides: Partial<AccountRead> = {}): AccountRead {
  return {
    id: 'acc-byn',
    name: 'Card BYN',
    type: 'card',
    currency: 'BYN',
    starting_balance_minor: 0,
    balance_minor: 0,
    archived: false,
    created_at: '2026-08-01T10:00:00Z',
    ...overrides,
  };
}

function receipt(overrides: Partial<ParsedReceiptRead> = {}): ParsedReceiptRead {
  return {
    total: '12.50',
    total_minor: 1250,
    currency: 'USD',
    merchant: 'Corner Shop',
    date: '2026-08-14',
    items: [],
    ...overrides,
  };
}

function category(overrides: Partial<CategoryRead> = {}): CategoryRead {
  return {
    id: 'cat-groceries',
    name: 'Groceries',
    kind: 'expense',
    icon: null,
    color: null,
    is_system: false,
    archived: false,
    ...overrides,
  };
}

// AM-5 (binding, grooming-review §4). The failure this pins is a 100x error, and
// it only shows up when the base currency's exponent is NOT 2 — hence a JPY base
// throughout, and two arms whose expected strings genuinely differ.
describe('buildConfirmDefaults — AM-5 decode of total_minor', () => {
  it('decodes a null-currency receipt at exponent 2, not at the base exponent', () => {
    // The server encodes a currency-less total at exponent 2, so 1250 IS 12.50.
    // A `toInputString(minor, parsed.currency ?? baseCurrency)` shortcut would
    // read the JPY exponent (0) and prefill "1250".
    const defaults = buildConfirmDefaults(receipt({ currency: null }), null, [], 'JPY', undefined);

    expect(defaults.amount).toBe('12.50');
    // ...while the CURRENCY, with no account to take it from, stands at the base
    // (the form cannot be submitted in that state anyway — account_id is required).
    expect(defaults.currency).toBe('JPY');
    expect(defaults.account_id).toBe('');
  });

  it('decodes a JPY receipt at the JPY exponent — same minor value, different string', () => {
    const defaults = buildConfirmDefaults(
      receipt({ currency: 'JPY', total: '1250' }),
      null,
      [],
      'JPY',
      undefined,
    );

    expect(defaults.amount).toBe('1250');
    expect(defaults.currency).toBe('JPY');
  });
});

describe('buildConfirmDefaults — the account decides the currency (§4)', () => {
  // The receipt printed EUR, the money is on a BYN account. The server stamps the
  // ACCOUNT's currency, so preselecting the printed one would only produce a 422 —
  // while the printed TOTAL is still decoded at the exponent it was encoded with,
  // so the number the user sees is the number on the paper (they correct it, and
  // W2 names the mismatch out loud).
  it('takes the currency from the account while decoding the total at the receipt currency', () => {
    const defaults = buildConfirmDefaults(
      receipt({ currency: 'EUR', total: '12.50' }),
      null,
      [],
      'JPY',
      { id: 'acc-byn', currency: 'BYN' },
    );

    expect(defaults.account_id).toBe('acc-byn');
    expect(defaults.currency).toBe('BYN');
    expect(defaults.amount).toBe('12.50');
  });
});

describe('buildConfirmDefaults', () => {
  it('derives the kind from a suggested INCOME category (not the expense default)', () => {
    const salary = category({ id: 'cat-salary', name: 'Salary', kind: 'income' });

    const defaults = buildConfirmDefaults(receipt(), 'cat-salary', [salary], 'USD', undefined);

    expect(defaults.category_id).toBe('cat-salary');
    expect(defaults.kind).toBe('income');
  });

  it('falls back to expense with no suggestion', () => {
    const defaults = buildConfirmDefaults(receipt(), null, [category()], 'USD', undefined);

    expect(defaults.category_id).toBe('');
    expect(defaults.kind).toBe('expense');
  });

  it('drops a suggested id the picker cannot render (archived / unknown)', () => {
    const archived = category({ id: 'cat-old', name: 'Old', archived: true });

    // Archived: present in the list, but not selectable in confirm mode.
    const onArchived = buildConfirmDefaults(receipt(), 'cat-old', [archived], 'USD', undefined);
    expect(onArchived.category_id).toBe('');
    expect(onArchived.kind).toBe('expense');

    // Unknown: an id that is not in the loaded list at all (stale cache).
    const onMissing = buildConfirmDefaults(receipt(), 'cat-gone', [category()], 'USD', undefined);
    expect(onMissing.category_id).toBe('');
  });

  it('falls back to today only when the receipt carries no date', () => {
    expect(buildConfirmDefaults(receipt(), null, [], 'USD', undefined).occurred_at).toBe('2026-08-14');
    expect(buildConfirmDefaults(receipt({ date: null }), null, [], 'USD', undefined).occurred_at).toBe(
      todayApiDate(),
    );
  });

  it('carries the merchant, and empties it when the receipt has none', () => {
    expect(buildConfirmDefaults(receipt(), null, [], 'USD', undefined).merchant).toBe('Corner Shop');
    expect(buildConfirmDefaults(receipt({ merchant: null }), null, [], 'USD', undefined).merchant).toBe('');
  });
});

describe('formatItemAmount', () => {
  it('formats against the parsed currency', () => {
    const formatted = formatItemAmount('12.50', 'USD');
    // Locale-agnostic assertion: the point is that it was FORMATTED (a symbol was
    // attached), not which side the symbol lands on.
    expect(formatted).not.toBe('12.50');
    expect(formatted).toMatch(/12[.,]50/);
  });

  it('renders the printed string verbatim when the receipt has no currency', () => {
    // Nothing to attach a symbol to, and borrowing the base currency would both
    // mislabel the money and re-encode it at the wrong exponent (AM-5).
    expect(formatItemAmount('12.50', null)).toBe('12.50');
  });

  it('renders dirty model output verbatim instead of NaN', () => {
    // Two separators are ambiguous, and 2 decimals are invalid for JPY: both must
    // survive as what the receipt said. (A single decimal comma, "12,50", is no
    // longer dirty — parseMoney reads it as the decimal point.)
    expect(formatItemAmount('1.234,50', 'USD')).toBe('1.234,50');
    expect(formatItemAmount('12.50', 'JPY')).toBe('12.50');
  });
});

// OQ-W2, second half: the account decides the currency the row is SAVED in (§4),
// so the receipt's printed currency is a preference for WHICH account to start
// on — and, when it cannot be honoured, something to say out loud.
describe('pickReceiptAccount', () => {
  const byn = account({ id: 'acc-byn', currency: 'BYN' });
  const eur = account({ id: 'acc-eur', currency: 'EUR' });

  it('prefers the account already in the receipt currency over the remembered one', () => {
    expect(pickReceiptAccount('EUR', [byn, eur], 'acc-byn')).toBe('acc-eur');
  });

  it('keeps the usual default when nothing can be matched on', () => {
    // No currency was read from the photo, so there is no preference to apply.
    expect(pickReceiptAccount(null, [byn, eur], 'acc-byn')).toBe('acc-byn');
    // A currency no account is in: the mismatch warning takes over from here.
    expect(pickReceiptAccount('JPY', [byn, eur], 'acc-byn')).toBe('acc-byn');
  });

  it('refuses to choose between two accounts in the receipt currency', () => {
    const eurSavings = account({ id: 'acc-eur-2', currency: 'EUR' });
    expect(pickReceiptAccount('EUR', [byn, eur, eurSavings], 'acc-byn')).toBe('acc-byn');
    // ...unless the remembered account is one of them, in which case the user's
    // own last choice is the tie-break rather than a guess.
    expect(pickReceiptAccount('EUR', [byn, eur, eurSavings], 'acc-eur-2')).toBe('acc-eur-2');
  });

  it('never starts on an archived account the form would not offer', () => {
    const archivedEur = account({ id: 'acc-eur-old', currency: 'EUR', archived: true });
    expect(pickReceiptAccount('EUR', [byn, archivedEur], 'acc-byn')).toBe('acc-byn');
  });
});

describe('receiptCurrencyMismatch', () => {
  it('names both currencies when the paper and the account disagree', () => {
    expect(receiptCurrencyMismatch('EUR', 'BYN')).toEqual({
      receiptCurrency: 'EUR',
      accountCurrency: 'BYN',
    });
  });

  it('says nothing when they agree or when there is nothing to compare', () => {
    expect(receiptCurrencyMismatch('BYN', 'BYN')).toBeNull();
    // The photo carried no currency...
    expect(receiptCurrencyMismatch(null, 'BYN')).toBeNull();
    // ...or no account is picked yet: warning about the base currency standing in
    // for an unpicked account would name a currency nothing will be saved in.
    expect(receiptCurrencyMismatch('EUR', undefined)).toBeNull();
  });
});
