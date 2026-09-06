// Moved to `@budget/api-client` (mobile-catchup-3, line C): the mobile
// transaction form grew the same plan-item picker, and "the field is expense-only
// and a kind flip clears it" is one rule for both clients. A RE-EXPORT so the
// import sites here are untouched.
export {
  NO_GOAL_ITEM,
  showsGoalItemField,
  goalItemSelectionForKind,
  goalItemOptions,
} from '@budget/api-client';
export type { GoalItemSelection, GoalItemOption } from '@budget/api-client';
