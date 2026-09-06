// Which nodes may become a given node's parent (goal-planner W1; moved out of
// apps/web in mobile-catchup-3 line C — the mobile move picker filters by the
// same rule, and web re-exports this).
//
// A pre-filter over the SAME rule the server enforces (routers/goal_items.py
// `_check_depth_and_cycle`), so the move dialog offers only choices that can
// succeed. It is NOT the guarantee: a concurrent tab can still make a listed
// target illegal, and 422 GOAL_ITEM_CYCLE / GOAL_ITEM_DEPTH_EXCEEDED are routed
// into the dialog for exactly that race.
//
// The rule, in the server's own terms:
//   ancestors(parent) INCLUDING parent  +  height(moved subtree)  <=  MAX_DEPTH
// and the first term IS `parent.depth`, because the server numbers roots 1. Both
// depths are SERVER fields (PM Q8); the only thing derived here is the moved
// subtree's height, which is structure, not money and not a date.
import type { components } from './generated/schema';

type GoalItemRead = components['schemas']['GoalItemRead'];
import { buildTree, descendantIds, type PlanNode } from './buildTree';

/** `goal_item_max_depth` (apps/api config, architecture §10a). */
export const MAX_PLAN_DEPTH = 6;

export interface MoveTarget {
  id: string;
  name: string;
  /** The server's level (roots = 1) — the dialog indents its options by it. */
  depth: number;
}

/** Levels in this subtree, counting the node itself: 1 for a leaf. */
function subtreeHeight(node: PlanNode): number {
  let height = 1;
  for (const child of node.children) height = Math.max(height, 1 + subtreeHeight(child));
  return height;
}

/**
 * Legal parents for `nodeId`, in the tree's own display order.
 *
 * Excluded: the node itself (it cannot be its own parent), every descendant of
 * it (that is the cycle), and any node too deep to hold the moved subtree.
 * Becoming a ROOT is always legal — a subtree can never be taller than the limit
 * to begin with — so the caller offers that option unconditionally and this list
 * carries real parents only.
 */
export function moveTargets(
  items: readonly GoalItemRead[],
  nodeId: string,
  maxDepth: number = MAX_PLAN_DEPTH,
): MoveTarget[] {
  const tree = buildTree(items);
  const node = tree.byId.get(nodeId);
  if (node === undefined) return [];

  const forbidden = descendantIds(node);
  const height = subtreeHeight(node);

  const targets: MoveTarget[] = [];
  const walk = (nodes: readonly PlanNode[]): void => {
    for (const candidate of nodes) {
      const { id, name, depth } = candidate.item;
      if (id !== nodeId && !forbidden.has(id) && depth + height <= maxDepth) {
        targets.push({ id, name, depth });
      }
      walk(candidate.children);
    }
  };
  walk(tree.roots);
  return targets;
}
