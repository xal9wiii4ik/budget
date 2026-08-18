import { describe, it, expect } from 'vitest';
import {
  formatApiDate,
  toApiDate,
  todayApiDate,
  monthParam,
  shiftMonth,
  monthBounds,
  formatMonthLabel,
  formatMonthShortLabel,
  shiftQuarter,
  sentenceEnd,
} from './dates';

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

describe('monthParam', () => {
  it('zero-pads a single-digit month', () => {
    expect(monthParam(2026, 7)).toBe('2026-07');
    expect(monthParam(2026, 12)).toBe('2026-12');
  });
});

describe('shiftMonth', () => {
  it('rolls Dec -> Jan and increments the year (+1)', () => {
    expect(shiftMonth('2025-12', 1)).toBe('2026-01');
  });

  it('rolls Jan -> Dec and decrements the year (-1)', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
  });

  it('stays within the year for a mid-year shift', () => {
    expect(shiftMonth('2026-07', -1)).toBe('2026-06');
  });
});

describe('shiftQuarter', () => {
  it('crosses the year boundary in both directions', () => {
    // The arm a naive `q ± delta` gets wrong: Q1-1 must roll back a YEAR to Q4,
    // and Q4+1 must roll forward a year to Q1, not produce "2026-Q0"/"2025-Q5".
    expect(shiftQuarter('2026-Q1', -1)).toBe('2025-Q4');
    expect(shiftQuarter('2025-Q4', 1)).toBe('2026-Q1');
  });
});

describe('monthBounds', () => {
  it('gives a 31-day December', () => {
    expect(monthBounds('2026-12')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });

  it('resolves leap February 2024 to the 29th', () => {
    expect(monthBounds('2024-02')).toEqual({ from: '2024-02-01', to: '2024-02-29' });
  });

  it('resolves non-leap February 2025 to the 28th', () => {
    expect(monthBounds('2025-02')).toEqual({ from: '2025-02-01', to: '2025-02-28' });
  });

  it('gives a 30-day April', () => {
    expect(monthBounds('2026-04')).toEqual({ from: '2026-04-01', to: '2026-04-30' });
  });
});

describe('formatMonthLabel', () => {
  it('renders "Month YYYY" in en-US', () => {
    expect(formatMonthLabel('2026-07', { locale: 'en-US' })).toBe('July 2026');
  });
});

describe('formatMonthShortLabel', () => {
  it('renders the compact chart-axis form with no month off-by-one or TZ shift', () => {
    // Its own local-midnight construction (a `new Date(y, m, 1)` slip would read
    // "Aug 26" here, which no other test would catch).
    expect(formatMonthShortLabel('2026-07', { locale: 'en-US' })).toBe('Jul 26');
    expect(formatMonthShortLabel('2026-01', { locale: 'en-US' })).toBe('Jan 26');
  });
});

describe('sentenceEnd', () => {
  // The real qa-web D4 case: the ru month label is ALREADY a terminated
  // sentence, so appending a dot in the JSX produced "июнь 2026 г..".
  it('leaves a label that already ends in a terminator alone', () => {
    expect(sentenceEnd('No transactions in июнь 2026 г.')).toBe(
      'No transactions in июнь 2026 г.',
    );
    expect(sentenceEnd('Готово?')).toBe('Готово?');
    expect(sentenceEnd('Готово!')).toBe('Готово!');
    expect(sentenceEnd('Загрузка…')).toBe('Загрузка…');
  });

  // The contrast arm: en-US labels carry no punctuation and MUST get the dot,
  // otherwise the "fix" would just delete the terminator everywhere.
  it('terminates a label that does not end in one', () => {
    expect(sentenceEnd('No transactions in June 2026')).toBe(
      'No transactions in June 2026.',
    );
  });

  it('returns an empty string rather than a lone dot', () => {
    expect(sentenceEnd('')).toBe('');
    expect(sentenceEnd('   ')).toBe('');
  });

  it('trims before deciding, so a trailing space cannot strand the dot', () => {
    expect(sentenceEnd('June 2026 ')).toBe('June 2026.');
    expect(sentenceEnd('июнь 2026 г. ')).toBe('июнь 2026 г.');
  });
});
