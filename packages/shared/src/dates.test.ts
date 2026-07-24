import { describe, it, expect } from 'vitest';
import { formatApiDate, toApiDate, todayApiDate } from './dates';

// TZ-shift guard. The `test` script pins TZ=America/Los_Angeles (a negative
// offset) before Node starts — Node caches TZ on first Date use, so setting it
// process-wide via the script is the reliable path (plan §4 recorded fallback;
// @types/node is not a dependency here, so `process.env.TZ` cannot be set in-file).
// The bug (`new Date('2026-07-24')` -> UTC midnight -> "Jul 23" in LA) would make
// this assertion fail; the local-component construction keeps it "Jul 24".
describe('formatApiDate', () => {
  it('formats without a timezone shift', () => {
    expect(formatApiDate('2026-07-24', { locale: 'en-US' })).toBe('Jul 24, 2026');
  });
});

describe('toApiDate', () => {
  it('zero-pads month and day from a local Date', () => {
    expect(toApiDate(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('todayApiDate', () => {
  it('is a local YYYY-MM-DD equal to toApiDate(new Date())', () => {
    expect(todayApiDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(todayApiDate()).toBe(toApiDate(new Date()));
  });
});
