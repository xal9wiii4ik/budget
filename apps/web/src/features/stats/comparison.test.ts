import { describe, expect, it } from 'vitest';

import { compare, share } from './comparison';

describe('compare', () => {
  it('refuses a percentage when there is no usable base', () => {
    // previous === 0: the naive `(delta / previous) * 100` is Infinity here, and
    // "+100 %" would be a lie about a period that had nothing.
    const fromZero = compare(50_000, 0);
    expect(fromZero).toEqual({ kind: 'no-base', deltaMinor: 50_000 });
    expect(fromZero).not.toHaveProperty('percent');

    // previous < 0 (a legitimately negative previous NET): a percentage against a
    // negative base flips sign for the wrong reason, so the absolute movement is
    // all we show.
    expect(compare(20_000, -10_000)).toEqual({ kind: 'no-base', deltaMinor: 30_000 });

    // Both zero is its own arm — "same as last period", NOT a 0 % change.
    expect(compare(0, 0)).toEqual({ kind: 'both-zero' });
  });

  it('gives a signed, rounded percent for a real base', () => {
    // +33.33… -> +33 (rounded), and the delta stays exact integer minor units.
    expect(compare(40_000, 30_000)).toEqual({
      kind: 'ratio',
      deltaMinor: 10_000,
      percent: 33,
    });
    expect(compare(15_000, 30_000)).toEqual({
      kind: 'ratio',
      deltaMinor: -15_000,
      percent: -50,
    });
    // The contrast arm that stops "0 means no data": equal non-zero values are a
    // REAL ratio of 0 %, not `both-zero` and not `no-base`.
    expect(compare(30_000, 30_000)).toEqual({
      kind: 'ratio',
      deltaMinor: 0,
      percent: 0,
    });
  });
});

describe('share', () => {
  it('has no denominator when the kind total is zero', () => {
    expect(share(0, 0)).toBeNull();
    expect(share(1_000, 0)).toBeNull();
  });

  it('is the rounded percentage of the server total', () => {
    expect(share(2_500, 10_000)).toBe(25);
    expect(share(3_333, 10_000)).toBe(33);
  });
});
