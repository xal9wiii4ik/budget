import { describe, expect, it } from 'vitest';

import type { GoalRead } from '../../data/goals';
import { realismContent } from './realism';

// A realistic goal on a deadline. Each case below flips only the fields its
// branch turns on, so the contrast between arms is the branch itself.
const base: GoalRead = {
  id: 'goal-1',
  name: 'New laptop',
  target_minor: 200000,
  currency: 'USD',
  deadline: '2026-12-31',
  priority: 1,
  archived: false,
  created_at: '2026-08-01T00:00:00Z',
  saved_minor: 50000,
  completed: false,
  monthly_needed_minor: 30000,
  realistic: true,
  months_to_target: 5,
  suggested_deadline: '2027-01-15',
  allocated_monthly_minor: 250000,
  realism_unavailable: false,
  base_currency: 'RUB',
  // goal-planner B1 plan fields. This goal has NO plan items, so the effective
  // target is its manual `target_minor` and every plan number is the server's
  // zero — realismContent reads none of them, and the fixture states them rather
  // than letting the shape drift from the contract.
  goal_currency: 'USD',
  has_items: false,
  initial_budget_minor: null,
  final_cost_override_minor: null,
  planned_total_minor: 0,
  planned_unconverted_count: 0,
  effective_target_minor: 200000,
  paid_minor: 0,
  paid_unconverted_count: 0,
  remaining_to_find_minor: 150000,
};

describe('realismContent', () => {
  it('reports on-track with the server monthly figure', () => {
    expect(realismContent(base)).toEqual({ status: 'on-track', monthlyNeededMinor: 30000 });
  });

  it('behind + months_to_target -> movable, echoing months AND the suggested date', () => {
    const view = realismContent({
      ...base,
      realistic: false,
      months_to_target: 7,
      suggested_deadline: '2027-03-15',
    });
    expect(view).toEqual({
      status: 'behind-movable',
      monthlyNeededMinor: 30000,
      monthsToTarget: 7,
      suggestedDeadline: '2027-03-15',
    });
  });

  it('behind + months_to_target but NO suggested date (F1 overflow guard) keeps months, invents no date', () => {
    const view = realismContent({
      ...base,
      realistic: false,
      months_to_target: 100000,
      suggested_deadline: null,
    });
    expect(view).toEqual({
      status: 'behind-movable',
      monthlyNeededMinor: 30000,
      monthsToTarget: 100000,
      suggestedDeadline: null,
    });
  });

  it('behind + months_to_target null -> unreachable, with no suggestion field at all', () => {
    const view = realismContent({
      ...base,
      realistic: false,
      months_to_target: null,
      suggested_deadline: null,
    });
    expect(view).toEqual({ status: 'behind-unreachable', monthlyNeededMinor: 30000 });
    expect('suggestedDeadline' in view).toBe(false);
  });

  it('realism_unavailable wins even when the other fields are still populated', () => {
    // Contract: when the flag is set those fields are null — but if a future
    // server ever left stale numbers there, the card must not present them as a
    // verdict it was told it cannot make.
    const view = realismContent({ ...base, realistic: false, realism_unavailable: true });
    expect(view).toEqual({ status: 'unavailable', currency: 'USD' });
  });

  it('treats a null `realistic` as unavailable rather than as "not realistic"', () => {
    expect(realismContent({ ...base, realistic: null }).status).toBe('unavailable');
  });

  it('a goal with no deadline is its own state, not "Need 0/month, on track"', () => {
    // Accepted deviation 1: the server returns monthly_needed_minor = 0 and
    // realistic = true for a deadline-less goal.
    const view = realismContent({
      ...base,
      deadline: null,
      monthly_needed_minor: 0,
      realistic: true,
    });
    expect(view).toEqual({ status: 'no-deadline' });
  });

  it('completed wins over every other flag', () => {
    const view = realismContent({
      ...base,
      completed: true,
      realistic: false,
      realism_unavailable: true,
      deadline: null,
    });
    expect(view).toEqual({ status: 'completed' });
  });
});
