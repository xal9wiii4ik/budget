// The "plan item" field of the transaction form (goal-planner W2), as pure rules.
//
// Two things live here, both of which the JSX would otherwise hide:
//
//   1. WHEN the field exists and what happens to it when the kind flips. The
//      server accepts an attachment on EXPENSES only (422 GOAL_ITEM_EXPENSE_ONLY,
//      architecture §3), so income never shows the control — and, exactly like
//      `category_id`, flipping the radio must CLEAR the selection rather than
//      keep it in hidden state, or the user assembles a body the server is
//      guaranteed to refuse without ever seeing the field that caused it.
//   2. The order and level of the item options. Reusing the plan screen's
//      `buildTree` keeps ONE definition of "the tree's display order" (and of
//      what happens to a node whose parent is missing) instead of a second,
//      subtly different flattening living in a form.
//
// No money, no dates, no server types beyond the node row itself.
import type { GoalItemRead } from '../../data/goalItems';
import { buildTree, type PlanNode } from '../goals/plan/buildTree';

/**
 * The form's attachment state. `goalId` is UI-only — it exists so the item list
 * can be fetched, and it is never sent: the wire carries `goal_item_id` alone.
 * `''` on either member is "nothing chosen", the `category_id` sentinel.
 */
export interface GoalItemSelection {
  goalId: string;
  itemId: string;
}

export const NO_GOAL_ITEM: GoalItemSelection = { goalId: '', itemId: '' };

/** Only an expense can pay for a plan item (architecture §3). */
export function showsGoalItemField(kind: 'expense' | 'income'): boolean {
  return kind === 'expense';
}

/**
 * The selection after a kind change: kept on expense, dropped otherwise.
 *
 * Returns the SAME object when nothing changes, so a caller can compare by
 * reference and skip a needless state write.
 */
export function goalItemSelectionForKind(
  selection: GoalItemSelection,
  kind: 'expense' | 'income',
): GoalItemSelection {
  if (showsGoalItemField(kind)) return selection;
  return selection.goalId === '' && selection.itemId === '' ? selection : NO_GOAL_ITEM;
}

export interface GoalItemOption {
  id: string;
  name: string;
  /** The server's level, roots = 1 — the `<option>` indents by it (Q8). */
  depth: number;
}

/**
 * Every node of one goal, in the tree's own display order, parents before their
 * children. A flat `<select>` cannot nest, so the level is carried alongside and
 * the option line is prefixed with it — the ItemMoveDialog convention.
 */
export function goalItemOptions(items: readonly GoalItemRead[]): GoalItemOption[] {
  const options: GoalItemOption[] = [];
  const walk = (nodes: readonly PlanNode[]): void => {
    for (const node of nodes) {
      options.push({ id: node.item.id, name: node.item.name, depth: node.item.depth });
      walk(node.children);
    }
  };
  walk(buildTree(items).roots);
  return options;
}
