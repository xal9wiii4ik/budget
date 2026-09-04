import { describe, expect, it } from 'vitest';

import { currencyOptions } from '../../components/currencyOptions';
import {
  editPrefillBaseAmount,
  previewAutofillValue,
  shouldShowConvertedSection,
} from './convertedSection';

// `buildCreateBody` and its form-values fixture moved to @budget/api-client with
// the builder itself (mobile-catchup-2, createBody.test.ts). What is left here is
// the converted section's own prefill/preview/visibility rules.

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
