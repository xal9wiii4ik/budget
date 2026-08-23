import { SUPPORTED_CURRENCIES } from '@budget/shared';
import { describe, expect, it } from 'vitest';

import { currencyOptions } from './currencyOptions';

describe('currencyOptions', () => {
  it('offers exactly the supported set when the stored base is inside it', () => {
    expect(currencyOptions('RUB')).toEqual([...SUPPORTED_CURRENCIES]);
  });

  it('prepends a stored base that is outside the supported set', () => {
    // The blank-<select> case: without this the screen would show no currency at
    // all for a user whose base is, say, JPY.
    expect(currencyOptions('JPY')).toEqual(['JPY', ...SUPPORTED_CURRENCIES]);
  });

  it('never lists the current base twice', () => {
    for (const code of [...SUPPORTED_CURRENCIES, 'JPY']) {
      const options = currencyOptions(code);
      expect(options.filter((option) => option === code)).toHaveLength(1);
    }
  });
});
