import { describe, expect, it } from 'vitest';

import { countryLabel } from './countryLabel';

// Node HAS Intl.DisplayNames, so the arm that actually runs on a phone is the one
// the gate would never see. Deleting the constructor for the duration of a test
// is the only way to exercise it under vitest.
const realDisplayNames = Intl.DisplayNames;

function setDisplayNames(value: unknown): void {
  Object.defineProperty(Intl, 'DisplayNames', {
    value,
    configurable: true,
    writable: true,
  });
}

function withoutDisplayNames(run: () => void): void {
  setDisplayNames(undefined);
  try {
    run();
  } finally {
    setDisplayNames(realDisplayNames);
  }
}

describe('countryLabel', () => {
  it('falls back to flag + code where Intl.DisplayNames is missing (Hermes)', () => {
    withoutDisplayNames(() => {
      // The contrast that matters: no throw, and something a human recognises —
      // not an empty label and not a RangeError from constructing a missing Intl.
      expect(countryLabel('en', 'GE')).toBe('🇬🇪 GE');
      expect(countryLabel('ru', 'BY')).toBe('🇧🇾 BY');
    });
    expect(countryLabel('en', 'GE')).toBe('Georgia');
  });

  it('never hands a malformed code to Intl (it throws a RangeError)', () => {
    expect(countryLabel('en', 'zz9')).toBe('zz9');
    withoutDisplayNames(() => {
      expect(countryLabel('en', 'zz9')).toBe('zz9');
    });
  });
});
