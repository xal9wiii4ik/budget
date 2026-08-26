import { describe, expect, it } from 'vitest';

import type { GoalItemRead } from '../../data/goalItems';
import {
  NO_GOAL_ITEM,
  goalItemOptions,
  goalItemSelectionForKind,
  showsGoalItemField,
} from './goalItemField';

function item(overrides: Partial<GoalItemRead> & { id: string }): GoalItemRead {
  return {
    goal_id: 'goal-1',
    parent_id: null,
    name: overrides.id,
    description: null,
    links: [],
    amount_minor: null,
    currency: 'EUR',
    converted_minor: null,
    converted_currency: null,
    children_sum_minor: 0,
    ceiling_exceeded: false,
    paid_minor: 0,
    paid_unconverted_count: 0,
    planned_unconverted_count: 0,
    deadline: null,
    effective_deadline: null,
    deadline_inherited: true,
    remind_on: null,
    remind_days_before: null,
    depth: 1,
    sort_order: 1024,
    files_count: 0,
    subtree_files_count: 0,
    created_at: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

describe('the plan-item field of the transaction form', () => {
  it('exists on an expense and not on an income (GOAL_ITEM_EXPENSE_ONLY)', () => {
    expect(showsGoalItemField('expense')).toBe(true);
    expect(showsGoalItemField('income')).toBe(false);
  });

  it('drops the selection when the kind flips away from expense', () => {
    const attached = { goalId: 'goal-1', itemId: 'item-1' };
    expect(goalItemSelectionForKind(attached, 'income')).toEqual(NO_GOAL_ITEM);
    // Flipping back must not resurrect it: an income row was saved with no link,
    // and the field the user cannot see must not hold a value they cannot check.
    expect(goalItemSelectionForKind(attached, 'expense')).toBe(attached);
  });

  it('leaves an already-empty selection untouched (same reference, no state write)', () => {
    expect(goalItemSelectionForKind(NO_GOAL_ITEM, 'income')).toBe(NO_GOAL_ITEM);
  });
});

describe('goalItemOptions', () => {
  it('lists parents before their children, each with the server depth', () => {
    // The <select> is flat, so the ORDER is what conveys the shape: a child
    // listed after an unrelated root would read as belonging to that root.
    const options = goalItemOptions([
      item({ id: 'hotel', parent_id: 'lodging', depth: 2 }),
      item({ id: 'flights', sort_order: 2048 }),
      item({ id: 'lodging', sort_order: 1024 }),
      item({ id: 'breakfast', parent_id: 'hotel', depth: 3 }),
    ]);

    expect(options).toEqual([
      { id: 'lodging', name: 'lodging', depth: 1 },
      { id: 'hotel', name: 'hotel', depth: 2 },
      { id: 'breakfast', name: 'breakfast', depth: 3 },
      { id: 'flights', name: 'flights', depth: 1 },
    ]);
  });
});
