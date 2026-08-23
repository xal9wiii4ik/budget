import { describe, expect, it } from 'vitest';

import { anchorsForDate, firstChargeDate, startDateConflict } from './firstCharge';

const monthly = (dayOfMonth: string) => ({ unit: 'month' as const, dayOfMonth, weekday: '' });
const weekly = (weekday: string) => ({ unit: 'week' as const, dayOfMonth: '', weekday });

describe('firstChargeDate — monthly', () => {
  it('rolls into the NEXT month when the anchor day is already behind the start', () => {
    // The shipped defect, verbatim: start 23 August, default "day 1".
    expect(firstChargeDate(monthly('1'), '2026-08-23')).toBe('2026-09-01');
    // …and across the year boundary, where a naive `month + 1` produces month 13.
    expect(firstChargeDate(monthly('1'), '2026-12-23')).toBe('2027-01-01');
  });

  it('stays in the start month when the anchor day is still ahead', () => {
    expect(firstChargeDate(monthly('28'), '2026-08-23')).toBe('2026-08-28');
  });

  it('clamps to the last day of a short month, in this month and in the next', () => {
    // The server rule (`domain/recurrence.py::monthly_due`): day 31 in April is
    // 30 April — never 1 May.
    expect(firstChargeDate(monthly('31'), '2026-04-15')).toBe('2026-04-30');
    expect(firstChargeDate(monthly('31'), '2026-02-01')).toBe('2026-02-28');
    // Rolling INTO a short month clamps as well: day 30 is behind 31 January, so
    // the answer is the NEXT month's clamped day, not "30 February".
    expect(firstChargeDate(monthly('30'), '2026-01-31')).toBe('2026-02-28');
  });
});

describe('firstChargeDate — weekly', () => {
  it('moves forward to the next matching ISO weekday (0 = Monday)', () => {
    // 2026-08-26 is a Wednesday (ISO 2); the next Friday (ISO 4) is the 28th.
    expect(firstChargeDate(weekly('4'), '2026-08-26')).toBe('2026-08-28');
    // Wrapping backwards through the week lands SEVEN days out, not in the past:
    // the next Tuesday (ISO 1) after a Wednesday is six days later.
    expect(firstChargeDate(weekly('1'), '2026-08-26')).toBe('2026-09-01');
    // 2026-12-31 is a Thursday (ISO 3); the next Monday crosses the year.
    expect(firstChargeDate(weekly('0'), '2026-12-31')).toBe('2027-01-04');
  });

  it('fires ON the start date when it already is the anchor weekday', () => {
    // The server's `or 7` (never the same day twice) applies to the WATERMARK,
    // which is seeded at start - 1 — so the start date itself is still owed.
    expect(firstChargeDate(weekly('2'), '2026-08-26')).toBe('2026-08-26');
  });
});

describe('startDateConflict', () => {
  it('is silent when the schedule already fires on the start date', () => {
    expect(startDateConflict(monthly('23'), '2026-08-23')).toBeNull();
    expect(startDateConflict(weekly('2'), '2026-08-26')).toBeNull();
  });

  it('is silent when a CLAMPED anchor matches the start date', () => {
    // Day 31 starting 30 April fires on 30 April: comparing dates rather than
    // day numbers is what keeps this from being a false alarm.
    expect(startDateConflict(monthly('31'), '2026-04-30')).toBeNull();
  });

  it('reports the real first charge date when the two disagree', () => {
    expect(startDateConflict(monthly('1'), '2026-08-23')).toBe('2026-09-01');
  });

  it('stays quiet while the pair cannot answer the question', () => {
    expect(startDateConflict(monthly('1'), '')).toBeNull();
    expect(startDateConflict(monthly(''), '2026-08-23')).toBeNull();
    expect(startDateConflict(weekly(''), '2026-08-23')).toBeNull();
    expect(startDateConflict(monthly('1'), '2026-02-31')).toBeNull();
  });
});

describe('anchorsForDate', () => {
  it('converts to the ISO weekday (0 = Monday), not JS getDay (0 = Sunday)', () => {
    // 2026-08-23 is a SUNDAY: JS 0, wire 6. Taking getUTCDay() verbatim would
    // make this Monday and silently ship a six-day-off schedule.
    expect(anchorsForDate('2026-08-23')).toEqual({ dayOfMonth: 23, weekday: 6 });
    expect(anchorsForDate('2026-08-31')).toEqual({ dayOfMonth: 31, weekday: 0 });
  });

  it('returns null for an empty or impossible date (clearing must not touch the anchor)', () => {
    expect(anchorsForDate('')).toBeNull();
    expect(anchorsForDate('2026-02-30')).toBeNull();
  });
});
