import { COUNTRY_CODES } from '@budget/shared';
import { describe, expect, it } from 'vitest';

import { countryOptions } from './countryOptions';

describe('countryOptions', () => {
  it('sorts by the LOCALIZED label, so the order follows the language', () => {
    const en = countryOptions('en');
    const ru = countryOptions('ru');
    expect(en.length).toBe(COUNTRY_CODES.length);
    // Sorted in each locale by that locale's own collation of its own labels.
    for (const [locale, options] of [
      ['en', en],
      ['ru', ru],
    ] as const) {
      const labels = options.map((option) => option.label);
      expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, locale)));
    }
    // Different languages genuinely produce a different order — the reason this
    // is computed per locale instead of once.
    expect(en.map((option) => option.code)).not.toEqual(ru.map((option) => option.code));
  });

  it('adds a code the shared table does not carry, exactly once', () => {
    // AQ is deliberately absent from COUNTRY_CURRENCIES (nothing to buy in
    // Antarctica) but is a well-formed value the server would accept.
    expect(COUNTRY_CODES).not.toContain('AQ');
    const options = countryOptions('en', 'AQ');
    expect(options.filter((option) => option.code === 'AQ')).toHaveLength(1);
    expect(options.length).toBe(COUNTRY_CODES.length + 1);
  });

  it('does not duplicate a code the table already has', () => {
    const options = countryOptions('en', 'BY');
    expect(options.filter((option) => option.code === 'BY')).toHaveLength(1);
    expect(options.length).toBe(COUNTRY_CODES.length);
  });

  it('ignores a malformed code instead of letting Intl throw on it', () => {
    expect(() => countryOptions('en', 'Belarus')).not.toThrow();
    expect(countryOptions('en', 'Belarus').length).toBe(COUNTRY_CODES.length);
  });
});
