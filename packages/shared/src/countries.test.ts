import { describe, expect, it } from 'vitest';

import { CURRENCY_CODE_PATTERN } from './currencies';
import {
  COUNTRY_CODES,
  COUNTRY_CODE_PATTERN,
  COUNTRY_CURRENCIES,
  countryToCurrency,
} from './countries';

// The table is hand-written, ~250 rows, and its two failure modes are silent: a
// typo'd country code becomes an option nobody can pick meaningfully (the label
// falls back to the raw code), and a typo'd currency code becomes a DEFAULT
// SPEND CURRENCY that formatMoney throws on (`assertWellFormedCurrency`). Both
// are checked mechanically here instead of by re-reading the list.
describe('COUNTRY_CURRENCIES', () => {
  it('holds well-formed ISO codes on both sides', () => {
    for (const [country, currency] of Object.entries(COUNTRY_CURRENCIES)) {
      expect(COUNTRY_CODE_PATTERN.test(country), country).toBe(true);
      expect(CURRENCY_CODE_PATTERN.test(currency), `${country} -> ${currency}`).toBe(true);
    }
  });

  it('names regions the runtime actually knows', () => {
    // Intl returns the input verbatim for a region it cannot name — the cheapest
    // available oracle for "is this a real ISO 3166-1 alpha-2 code".
    const names = new Intl.DisplayNames(['en'], { type: 'region' });
    const unknown = COUNTRY_CODES.filter((code) => names.of(code) === code);
    expect(unknown).toEqual([]);
  });

  it('exposes every mapped country as an option', () => {
    expect(COUNTRY_CODES).toHaveLength(Object.keys(COUNTRY_CURRENCIES).length);
    expect(COUNTRY_CODES).toContain('BY');
  });
});

describe('countryToCurrency', () => {
  it('resolves a known country', () => {
    expect(countryToCurrency('BY')).toBe('BYN');
    expect(countryToCurrency('JP')).toBe('JPY');
  });

  it('answers null instead of guessing', () => {
    // "not set" (the form sentinel), an unset profile, a code outside the table
    // and a malformed one all mean the same thing: nothing to default from.
    expect(countryToCurrency('')).toBeNull();
    expect(countryToCurrency(null)).toBeNull();
    expect(countryToCurrency(undefined)).toBeNull();
    expect(countryToCurrency('ZZ')).toBeNull();
    expect(countryToCurrency('by')).toBeNull();
  });
});
