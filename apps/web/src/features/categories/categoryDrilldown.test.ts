import { describe, expect, it } from 'vitest';

import type { StatsSummaryRead } from '../../data/stats';
import { categoryPeriodTotal, categoryTransactionsHref } from './categoryDrilldown';

const FOOD = '11111111-1111-4111-8111-111111111111';
const SALARY = '22222222-2222-4222-8222-222222222222';

function summary(by_category: StatsSummaryRead['by_category']): StatsSummaryRead {
  return {
    period: { from: '2026-08-01', to: '2026-08-31' },
    currency: 'USD',
    income_minor: 0,
    expense_minor: 0,
    net_minor: 0,
    by_category,
    unconverted_count: 0,
    previous: {
      from: '2026-07-01',
      to: '2026-07-31',
      income_minor: 0,
      expense_minor: 0,
      net_minor: 0,
      unconverted_count: 0,
    },
  };
}

describe('categoryPeriodTotal', () => {
  it('picks the row matching BOTH the id and the category kind', () => {
    // The same category id under two kinds is what a refund produces: an
    // implementation matching on the id alone would show 500 (the refund) as
    // what was spent on food.
    const rows = summary([
      { category_id: FOOD, kind: 'expense', total_minor: 12_345 },
      { category_id: FOOD, kind: 'income', total_minor: 500 },
      { category_id: SALARY, kind: 'income', total_minor: 900_000 },
    ]);

    expect(categoryPeriodTotal(rows, FOOD, 'expense')).toBe(12_345);
    expect(categoryPeriodTotal(rows, FOOD, 'income')).toBe(500);
    expect(categoryPeriodTotal(rows, SALARY, 'income')).toBe(900_000);
  });

  it('is 0 when the period has no row for this category', () => {
    // The server omits empty buckets, so "absent" is the ordinary case for a
    // category with nothing in the window — not an unknown to render as a dash.
    expect(categoryPeriodTotal(summary([]), FOOD, 'expense')).toBe(0);
    expect(
      categoryPeriodTotal(
        summary([{ category_id: SALARY, kind: 'income', total_minor: 900_000 }]),
        FOOD,
        'expense',
      ),
    ).toBe(0);
    // An uncategorized bucket (`category_id: null`) belongs to no category.
    expect(
      categoryPeriodTotal(
        summary([{ category_id: null, kind: 'expense', total_minor: 700 }]),
        FOOD,
        'expense',
      ),
    ).toBe(0);
  });
});

describe('categoryTransactionsHref', () => {
  it('writes the parameters parseTxFilters reads, per period mode', () => {
    expect(categoryTransactionsHref(FOOD, { kind: 'month', month: '2026-08' })).toBe(
      `/transactions?category=${FOOD}&month=2026-08`,
    );
    expect(
      categoryTransactionsHref(FOOD, {
        kind: 'custom',
        from: '2026-08-01',
        to: '2026-08-15',
      }),
    ).toBe(`/transactions?category=${FOOD}&from=2026-08-01&to=2026-08-15`);
  });
});
