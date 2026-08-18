import { describe, expect, it } from 'vitest';

import { budgetsVisibility } from './budgetsVisibility';

describe('budgetsVisibility', () => {
  it('passes the SELECTED month through, not the current one', () => {
    // A month in the past on purpose: an implementation that reached for
    // `currentMonth()` (the /categories rule) instead of the selection would
    // still return `visible: true` and only fail on this field.
    expect(budgetsVisibility({ unit: 'month', month: '2025-11' })).toEqual({
      visible: true,
      month: '2025-11',
    });
  });

  it('is hidden for every non-month unit — a budget is a calendar month (D16)', () => {
    expect(budgetsVisibility({ unit: 'quarter', quarter: '2026-Q1' })).toEqual({
      visible: false,
    });
    expect(budgetsVisibility({ unit: 'year', year: 2026 })).toEqual({ visible: false });
    expect(
      budgetsVisibility({ unit: 'custom', from: '2026-01-01', to: '2026-03-31' }),
    ).toEqual({ visible: false });
  });
});
