// The rule that shipped broken (D-1) and the one place a hand-written CLDR table
// can silently drift. Deliberately NOT a copy of web's t.test.ts: only the plural
// categories are mobile's own code, plus one `translate()` case to pin the wiring
// (t.ts must pass the LANGUAGE, not the locale, into selectForm).
import { describe, expect, it } from 'vitest';

import { pluralCategory } from './plural';
import { translate } from './t';

describe('pluralCategory: en', () => {
  it('is `one` only for exactly 1', () => {
    expect(pluralCategory('en', 0)).toBe('other');
    expect(pluralCategory('en', 1)).toBe('one');
    expect(pluralCategory('en', 2)).toBe('other');
  });
});

describe('pluralCategory: ru', () => {
  it('gives `one` to 1, 21, 101 (n % 10 === 1, n % 100 !== 11)', () => {
    for (const n of [1, 21, 101]) expect(pluralCategory('ru', n)).toBe('one');
  });

  it('gives `few` to 2, 3, 4, 22 (n % 10 in 2..4)', () => {
    for (const n of [2, 3, 4, 22]) expect(pluralCategory('ru', n)).toBe('few');
  });

  it('gives `many` to 5, 11..14, 19, 20, 100 — including the teens the mod-10 rule would misplace', () => {
    for (const n of [5, 11, 12, 14, 19, 20, 100]) expect(pluralCategory('ru', n)).toBe('many');
  });

  it('gives `other` to a fraction', () => {
    expect(pluralCategory('ru', 1.5)).toBe('other');
  });
});

describe('translate through the dictionary', () => {
  it('selects the ru forms for 1 / 2 / 5', () => {
    expect(translate('ru', 'accountCount', { count: 1 })).toBe('1 счёт');
    expect(translate('ru', 'accountCount', { count: 2 })).toBe('2 счёта');
    expect(translate('ru', 'accountCount', { count: 5 })).toBe('5 счетов');
  });
});
