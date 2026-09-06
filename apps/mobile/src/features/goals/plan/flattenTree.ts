// The tree, as a FLAT list of rows a FlatList can render (mobile-catchup-3, line C).
//
// Web draws the plan as nested <ul>s; a phone cannot, because an unbounded number
// of nodes inside a ScrollView is exactly the pattern this client does not use.
// So the ONE client-side derivation of the plan screen — `buildTree`'s order and
// nesting (@budget/api-client) — is walked once into a linear array, and the
// indent comes from the SERVER's `depth` on each row (never recomputed here).
//
// The only thing this module owns beyond the walk is COLLAPSE: a collapsed node
// keeps its own row and drops its whole subtree, and `isFirst` / `isLast` describe
// the position among SIBLINGS (what the up/down buttons act on), not the position
// in the flattened array.
//
// No money, no dates, no server types beyond the node row itself.
import type { PlanNode } from '@budget/api-client';

export interface PlanRow {
  node: PlanNode;
  /** First among its siblings — "move up" is a no-op and the button is disabled. */
  isFirst: boolean;
  /** Last among its siblings — same, for "move down". */
  isLast: boolean;
  /** This node has children AND they are hidden right now. */
  collapsed: boolean;
  /** This node has children at all — only then is a collapse toggle drawn. */
  hasChildren: boolean;
}

/**
 * Depth-first, parents before their children, siblings in the tree's own order.
 *
 * `collapsedIds` holds the nodes the user closed; a node's descendants are
 * skipped wholesale when it is in there, which is why the recursion returns
 * before walking them rather than filtering afterwards (a 500-node plan under one
 * collapsed root must cost one comparison, not 500).
 */
export function flattenTree(
  roots: readonly PlanNode[],
  collapsedIds: ReadonlySet<string>,
): PlanRow[] {
  const rows: PlanRow[] = [];

  const walk = (siblings: readonly PlanNode[]): void => {
    siblings.forEach((node, index) => {
      const hasChildren = node.children.length > 0;
      const collapsed = hasChildren && collapsedIds.has(node.item.id);
      rows.push({
        node,
        isFirst: index === 0,
        isLast: index === siblings.length - 1,
        collapsed,
        hasChildren,
      });
      if (hasChildren && !collapsed) walk(node.children);
    });
  };

  walk(roots);
  return rows;
}
