import { describe, expect, it } from 'vitest';
import type { MultiCurrencyTransactionFormValues } from '@budget/shared';

import { currencyOptions } from '../../components/currencyOptions';
import {
  buildCreateBody,
  editPrefillBaseAmount,
  previewAutofillValue,
  shouldShowConvertedSection,
} from './convertedSection';

// Base currency is RUB throughout; the form holds a foreign (USD) amount.
const values: MultiCurrencyTransactionFormValues = {
  amount: 1250,
  currency: 'USD',
  base_amount_minor: 9000,
  kind: 'expense',
  category_id: 'cat-1',
  occurred_at: '2026-08-15',
  note: '',
};

describe('buildCreateBody', () => {
  it('sends base_amount_minor when the user edited the converted field', () => {
    const body = buildCreateBody(values, 'RUB', true);
    expect(body.base_amount_minor).toBe(9000);
    expect(body.currency).toBe('USD');
  });

  it('OMITS an autofilled-but-untouched converted value (server recomputes)', () => {
    // Same parsed value, only the edited flag differs from the case above — the
    // contrast that pins Disagreement 1: a preview echo is never stored as an
    // override.
    const body = buildCreateBody(values, 'RUB', false);
    expect('base_amount_minor' in body).toBe(false);
  });

  it('never sends base_amount_minor for a base-currency row', () => {
    // Even with an edited flag and a stale parsed value: a base-currency row's
    // amount_minor IS its base amount (the server 422s a second copy).
    const body = buildCreateBody({ ...values, currency: 'RUB' }, 'RUB', true);
    expect('base_amount_minor' in body).toBe(false);
    expect(body.currency).toBe('RUB');
  });
});

describe('editPrefillBaseAmount', () => {
  it('decodes the stored snapshot with its PAIRED currency (AM-5)', () => {
    expect(
      editPrefillBaseAmount({ base_amount_minor: 9000, base_currency: 'RUB' }, 'RUB'),
    ).toBe('90.00');
  });

  it('hides a stale-base snapshot (pair currency != profile base)', () => {
    // The D5 base-change bypass: an override in a currency that is no longer the
    // base must not be presented as active.
    expect(
      editPrefillBaseAmount({ base_amount_minor: 9000, base_currency: 'EUR' }, 'RUB'),
    ).toBe('');
  });

  it('returns "" (auto) when there is no snapshot', () => {
    expect(
      editPrefillBaseAmount({ base_amount_minor: null, base_currency: null }, 'RUB'),
    ).toBe('');
  });
});

describe('previewAutofillValue', () => {
  it('decodes converted_minor with the echoed `to` currency', () => {
    expect(
      previewAutofillValue({
        amount_minor: 2500,
        converted_minor: 207491,
        from: 'USD',
        rate: '82.99643696',
        rate_as_of: '2026-08-15',
        to: 'RUB',
      }),
    ).toBe('2074.91');
  });

  it('CLEARS the field when the result has no rate (null triple)', () => {
    // O1: an untouched value is omitted from the create body, so the row stores
    // NULL — the previous autofill must not stay on screen as if it would be saved.
    expect(
      previewAutofillValue({
        amount_minor: 2500,
        converted_minor: null,
        from: 'USD',
        rate: null,
        rate_as_of: null,
        to: 'RUB',
      }),
    ).toBe('');
  });
});

describe('shouldShowConvertedSection', () => {
  it('shows only for a foreign currency', () => {
    expect(shouldShowConvertedSection('USD', 'RUB')).toBe(true);
    expect(shouldShowConvertedSection('RUB', 'RUB')).toBe(false);
  });
});

describe('currencyOptions', () => {
  it('offers the supported set, appends an out-of-set extra, dedupes a known one', () => {
    expect(currencyOptions()).toEqual(['USD', 'EUR', 'RUB', 'BYN']);
    expect(currencyOptions('JPY')).toEqual(['USD', 'EUR', 'RUB', 'BYN', 'JPY']);
    expect(currencyOptions('EUR')).toEqual(['USD', 'EUR', 'RUB', 'BYN']);
    expect(currencyOptions(null)).toEqual(['USD', 'EUR', 'RUB', 'BYN']);
  });
});
