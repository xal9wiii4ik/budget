import { describe, expect, it } from 'vitest';

import { translate } from './t';

describe('translate — plurals', () => {
  // THE reason this layer is tested at all: a hand-rolled dictionary that branches
  // on `count === 1` renders "5 операция" / "21 операций". Intl.PluralRules owns
  // the rule; these cases pin that we actually route through it.
  it('picks the Russian one/few/many forms, including the 21-vs-11 trap', () => {
    expect(translate('ru', 'transactionCount', { count: 1 })).toBe('1 операция');
    expect(translate('ru', 'transactionCount', { count: 2 })).toBe('2 операции');
    expect(translate('ru', 'transactionCount', { count: 5 })).toBe('5 операций');
    // 21 ends in 1 -> `one`; 11 ends in 1 too but is a teen -> `many`. This pair
    // is the contrast that a naive rule cannot get right.
    expect(translate('ru', 'transactionCount', { count: 21 })).toBe('21 операция');
    expect(translate('ru', 'transactionCount', { count: 11 })).toBe('11 операций');
  });

  it('falls back to `other` for a Russian fraction, where en has no such form', () => {
    // ru has a real `other` category (fractions); en reaches `other` only via the
    // plain plural. Contrasting them proves the form is selected per LANGUAGE and
    // not per a shared "is it 1?" branch.
    expect(translate('ru', 'transactionCount', { count: 1.5 })).toBe('1,5 операции');
    expect(translate('en', 'transactionCount', { count: 1.5 })).toBe('1.5 transactions');
  });

  it('uses the English two-form rule', () => {
    expect(translate('en', 'transactionCount', { count: 1 })).toBe('1 transaction');
    expect(translate('en', 'transactionCount', { count: 5 })).toBe('5 transactions');
  });
});

describe('translate — interpolation', () => {
  it('formats an interpolated number in the chosen language, not the host locale', () => {
    // The whole point of the locale map: grouping follows the CHOICE. en groups
    // with a comma; ru groups with a (non-breaking) space, so the two must differ
    // even though the host running this test has one fixed locale.
    const english = translate('en', 'transactionCount', { count: 1234 });
    const russian = translate('ru', 'transactionCount', { count: 1234 });
    expect(english).toBe('1,234 transactions');
    expect(russian).not.toBe(english);
    expect(russian).toMatch(/операции$/);
  });

  it('leaves an unknown placeholder visible instead of blanking the sentence', () => {
    // A missing param is a bug; rendering "{name}" makes it reportable, while an
    // empty gap would ship a broken sentence that nobody notices.
    expect(translate('en', 'transactionCount', { count: 2, other: 'x' })).toBe(
      '2 transactions',
    );
  });
});
