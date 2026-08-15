// The goal card's realism messaging decision table (3.2 W3), extracted as a pure
// function so the branch choice is vitest-pinned instead of living in nested JSX
// ternaries. GoalCard renders the returned view and adds no logic of its own.
//
// Every number in the view is a SERVER field echoed verbatim (D12: the calculator
// is server-side only). Nothing here divides, multiplies, adds a month or invents
// a date — if the server did not send a suggestion, the card shows none.
import type { GoalRead } from '../../data/goals';

export type RealismView =
  // Reached the target — realism is moot and would read as an insult.
  | { status: 'completed' }
  // [SL-3] per-goal degradation: no rate from this goal's currency to the base
  // today, so realistic / months_to_target / suggested_deadline are all null and
  // the goal takes no allocation. Siblings still render fully.
  | { status: 'unavailable'; currency: string }
  // Accepted deviation 1 (S4/S5 meta-review): a goal with no deadline gets
  // monthly_needed_minor = 0 and realistic = true from the server. "Need $0/month.
  // On track!" would be nonsense, so this is its own honest state.
  | { status: 'no-deadline' }
  | { status: 'on-track'; monthlyNeededMinor: number }
  // Not reachable by the deadline, but the server DID compute how long it takes.
  // `suggestedDeadline` is nullable even when monthsToTarget is not (the F1
  // year-overflow guard) — the card then states the months without a date.
  | {
      status: 'behind-movable';
      monthlyNeededMinor: number;
      monthsToTarget: number;
      suggestedDeadline: string | null;
    }
  // months_to_target === null: the free balance doesn't cover this goal at all
  // (D11's unreachable case). No suggestion exists and none is invented.
  | { status: 'behind-unreachable'; monthlyNeededMinor: number };

/**
 * Precedence: completed > unavailable > no-deadline > on-track > behind.
 *
 * `realistic === null` is folded into `unavailable`: the contract ties the two
 * together (null realism fields iff realism_unavailable), and treating a null as
 * "not realistic" would put an accusation on screen that the server never made.
 */
export function realismContent(goal: GoalRead): RealismView {
  if (goal.completed) return { status: 'completed' };
  if (goal.realism_unavailable || goal.realistic === null) {
    return { status: 'unavailable', currency: goal.currency };
  }
  if (goal.deadline === null) return { status: 'no-deadline' };
  if (goal.realistic) {
    return { status: 'on-track', monthlyNeededMinor: goal.monthly_needed_minor };
  }
  if (goal.months_to_target !== null) {
    return {
      status: 'behind-movable',
      monthlyNeededMinor: goal.monthly_needed_minor,
      monthsToTarget: goal.months_to_target,
      suggestedDeadline: goal.suggested_deadline,
    };
  }
  return { status: 'behind-unreachable', monthlyNeededMinor: goal.monthly_needed_minor };
}
