import { currentMonth } from '@budget/shared';
import { describe, expect, it } from 'vitest';

import {
  parsePeriodParams,
  periodQuery,
  periodSearchParams,
  shiftPeriod,
  type PeriodSelection,
} from './period';

const params = (query: string) => new URLSearchParams(query);

describe('parsePeriodParams', () => {
  it('falls back to the current month for every malformed input, and leaves a valid one alone', () => {
    // These four are exactly what keeps 422 PERIOD_ANCHOR_REQUIRED unreachable:
    // no params at all, the chosen unit's anchor missing, an anchor that belongs
    // to a DIFFERENT unit, and an unknown unit.
    const fallback: PeriodSelection = { unit: 'month', month: currentMonth() };
    expect(parsePeriodParams(params(''))).toEqual(fallback);
    expect(parsePeriodParams(params('period=month'))).toEqual(fallback);
    expect(parsePeriodParams(params('period=year&month=2026-08'))).toEqual(fallback);
    expect(parsePeriodParams(params('period=bogus'))).toEqual(fallback);
    // The contrast arm: a well-formed selection must survive untouched, otherwise
    // the four assertions above would also pass on a function that always returns
    // the fallback.
    expect(parsePeriodParams(params('period=quarter&quarter=2026-Q2'))).toEqual({
      unit: 'quarter',
      quarter: '2026-Q2',
    });
  });
});

describe('periodQuery', () => {
  it('emits `period` plus EXACTLY the one anchor its unit needs', () => {
    // Object equality, not property presence: a stray `month` alongside
    // `period=year` — the shape the picker must never produce — fails here.
    expect(periodQuery({ unit: 'month', month: '2026-08' })).toEqual({
      period: 'month',
      month: '2026-08',
    });
    expect(periodQuery({ unit: 'quarter', quarter: '2026-Q3' })).toEqual({
      period: 'quarter',
      quarter: '2026-Q3',
    });
    expect(periodQuery({ unit: 'year', year: 2026 })).toEqual({
      period: 'year',
      year: 2026,
    });
    expect(
      periodQuery({ unit: 'custom', from: '2026-03-10', to: '2026-03-20' }),
    ).toEqual({ period: 'custom', from: '2026-03-10', to: '2026-03-20' });
  });
});

describe('periodSearchParams -> parsePeriodParams', () => {
  it('round-trips every unit', () => {
    const selections: PeriodSelection[] = [
      { unit: 'month', month: '2026-08' },
      { unit: 'quarter', quarter: '2026-Q3' },
      { unit: 'year', year: 2026 },
      { unit: 'custom', from: '2026-03-10', to: '2026-03-20' },
    ];
    for (const selection of selections) {
      expect(parsePeriodParams(new URLSearchParams(periodSearchParams(selection)))).toEqual(
        selection,
      );
    }
  });
});

describe('shiftPeriod', () => {
  it('steps the three calendar units and is the identity for custom', () => {
    expect(shiftPeriod({ unit: 'month', month: '2026-01' }, -1)).toEqual({
      unit: 'month',
      month: '2025-12',
    });
    expect(shiftPeriod({ unit: 'quarter', quarter: '2025-Q4' }, 1)).toEqual({
      unit: 'quarter',
      quarter: '2026-Q1',
    });
    expect(shiftPeriod({ unit: 'year', year: 2026 }, -1)).toEqual({
      unit: 'year',
      year: 2025,
    });
    // Custom has no "the same length immediately before" navigation gesture —
    // that is a server concept for the comparison block only (the stepper is not
    // even rendered), so stepping must not silently move the window.
    const custom: PeriodSelection = { unit: 'custom', from: '2026-03-10', to: '2026-03-20' };
    expect(shiftPeriod(custom, 1)).toEqual(custom);
    expect(shiftPeriod(custom, -1)).toEqual(custom);
  });
});
