import { formatMoney } from '@budget/shared';
import { describe, expect, it } from 'vitest';

import type { LimitItem } from '../../data/limits';
import { limitProgress } from './limitProgress';

function item(overrides: Partial<LimitItem>): LimitItem {
  return {
    category_id: 'cat-1',
    limit_currency: 'RUB',
    limit_minor: 30_000,
    spent_minor: 12_000,
    ...overrides,
  };
}

describe('limitProgress', () => {
  it('is under with the remaining amount and a sub-1 ratio while below the budget', () => {
    const progress = limitProgress(
      item({ limit_minor: 30_000, spent_minor: 12_000 }),
      'RUB',
    );

    expect(progress.status).toBe('under');
    if (progress.status === 'mismatch') throw new Error('expected a comparison');
    expect(progress.remainingMinor).toBe(18_000);
    expect(progress.ratio).toBeLessThan(1);
    expect(progress.ratio).toBeCloseTo(0.4);
  });

  it('treats spending EXACTLY the budget as under, one minor unit more as over (R4)', () => {
    // The boundary, proven by contrast: `>` not `>=`. Spending your whole budget
    // is not an overrun, and the two arms differ by a single minor unit.
    const exact = limitProgress(item({ limit_minor: 30_000, spent_minor: 30_000 }), 'RUB');
    expect(exact.status).toBe('under');
    if (exact.status === 'mismatch') throw new Error('expected a comparison');
    expect(exact.remainingMinor).toBe(0);

    const overByOne = limitProgress(
      item({ limit_minor: 30_000, spent_minor: 30_001 }),
      'RUB',
    );
    expect(overByOne.status).toBe('over');
  });

  it('clamps the ratio to exactly 1 when over, keeping remaining negative', () => {
    const progress = limitProgress(
      item({ limit_minor: 30_000, spent_minor: 45_000 }),
      'RUB',
    );

    expect(progress.status).toBe('over');
    if (progress.status === 'mismatch') throw new Error('expected a comparison');
    // Presentation geometry: a CSS width can never exceed the track.
    expect(progress.ratio).toBe(1);
    // The magnitude of the overrun stays exact for "over by …".
    expect(progress.remainingMinor).toBe(-15_000);
  });

  it('gates the comparison on the currency stamp: mismatch carries no ratio and no status', () => {
    // The SAME numbers that produce 'over' above — so this proves the GATE, not
    // the arithmetic: 45 000 units of one currency is not more than 30 000 of
    // another, and the function refuses to say it is.
    const progress = limitProgress(
      item({ limit_minor: 30_000, limit_currency: 'USD', spent_minor: 45_000 }),
      'RUB',
    );

    expect(progress.status).toBe('mismatch');
    expect('ratio' in progress).toBe(false);
    expect('remainingMinor' in progress).toBe(false);
    // Both currencies survive, each attached to its own number (AM-5).
    expect(progress.limitCurrency).toBe('USD');
    expect(progress.currency).toBe('RUB');
  });

  it('is under with ratio 0 for a limited category with no spending yet', () => {
    const progress = limitProgress(item({ limit_minor: 30_000, spent_minor: 0 }), 'RUB');

    expect(progress.status).toBe('under');
    if (progress.status === 'mismatch') throw new Error('expected a comparison');
    expect(progress.ratio).toBe(0);
    expect(progress.remainingMinor).toBe(30_000);
  });

  it('renders each amount with ITS OWN currency — swapping them is a 100x error (T8prime)', () => {
    // A JPY budget (exponent 0) against RUB spending (exponent 2), the same
    // minor value in both, which is what makes the decode error visible.
    const progress = limitProgress(
      item({ limit_minor: 5_000, limit_currency: 'JPY', spent_minor: 5_000 }),
      'RUB',
    );
    if (progress.status !== 'mismatch') throw new Error('expected mismatch');

    const limitText = formatMoney(progress.limitMinor, progress.limitCurrency, {
      locale: 'en-US',
    });
    const spentText = formatMoney(progress.spentMinor, progress.currency, {
      locale: 'ru-RU',
    });
    expect(limitText).toBe('¥5,000');
    expect(spentText).toContain('50,00');

    // The contrast arm: reaching for the OTHER currency at either site (the
    // `?? fallback` AM-5 forbids) moves the decimal point two places.
    expect(formatMoney(5_000, 'RUB', { locale: 'en-US' })).toContain('50.00');
    expect(formatMoney(5_000, 'JPY', { locale: 'ru-RU' })).not.toContain('50,00');
    expect(limitText).not.toBe(spentText);
  });
});
