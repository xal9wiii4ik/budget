// Flat list -> render tree (goal-planner W1).
//
// The ONE derivation this screen makes from the server's answer, and deliberately
// not a money or date one: `GET /goals/{goal_id}/items` returns every node of the
// goal in a single response (architecture §4 — one recursive CTE, no N+1) and the
// client only decides the ORDER and NESTING it draws them in.
//
// Everything else stays a server field. `depth` in particular is NOT recomputed
// here (PM Q8): it arrives on the row, so a node's level survives a re-parent
// without the client re-walking the tree, and the "add a child" affordance can be
// gated on the same number the server gates the write on.
import type { GoalItemRead } from '../../../data/goalItems';

export interface PlanNode {
  item: GoalItemRead;
  children: PlanNode[];
}

export interface PlanTree {
  roots: PlanNode[];
  /** Every node by id — the row-level lookups (move dialog, delete dialog) use it. */
  byId: Map<string, PlanNode>;
}

/** Siblings are ordered by the server's `sort_order`, ties broken by `id`. */
function bySortOrder(a: PlanNode, b: PlanNode): number {
  if (a.item.sort_order !== b.item.sort_order) return a.item.sort_order - b.item.sort_order;
  return a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0;
}

function markReachable(from: readonly PlanNode[], reached: Set<string>): void {
  const stack = [...from];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) continue;
    if (reached.has(node.item.id)) continue;
    reached.add(node.item.id);
    stack.push(...node.children);
  }
}

/**
 * Build the tree.
 *
 * A node whose `parent_id` is not in the list is NOT dropped — it is raised to
 * the roots. Losing a row that carries money because its parent is missing is a
 * far worse failure than one wrong indent, and this is exactly what a partially
 * filtered or racing response looks like.
 *
 * The same rule covers the (DB-impossible: trigger + composite FK, architecture
 * §2) case of a parent CYCLE: any node the roots cannot reach is detached from
 * its parent and raised, so a malformed response can never render into an
 * infinitely deep tree.
 */
export function buildTree(items: readonly GoalItemRead[]): PlanTree {
  const byId = new Map<string, PlanNode>();
  for (const item of items) byId.set(item.id, { item, children: [] });

  const roots: PlanNode[] = [];
  for (const node of byId.values()) {
    const parentId = node.item.parent_id;
    const parent = parentId === null ? undefined : byId.get(parentId);
    if (parent === undefined || parent === node) {
      roots.push(node);
      continue;
    }
    parent.children.push(node);
  }

  const reached = new Set<string>();
  markReachable(roots, reached);
  for (const node of byId.values()) {
    if (reached.has(node.item.id)) continue;
    const parentId = node.item.parent_id;
    const parent = parentId === null ? undefined : byId.get(parentId);
    if (parent !== undefined) {
      parent.children = parent.children.filter((child) => child !== node);
    }
    roots.push(node);
    markReachable([node], reached);
  }

  roots.sort(bySortOrder);
  for (const node of byId.values()) node.children.sort(bySortOrder);

  return { roots, byId };
}

/** The node itself plus every descendant — the count the delete dialog names. */
export function subtreeSize(node: PlanNode): number {
  let count = 1;
  for (const child of node.children) count += subtreeSize(child);
  return count;
}

/** Ids of every descendant (the node itself excluded) — `moveTargets` uses it. */
export function descendantIds(node: PlanNode): Set<string> {
  const ids = new Set<string>();
  const stack = [...node.children];
  while (stack.length > 0) {
    const child = stack.pop();
    if (child === undefined) continue;
    if (ids.has(child.item.id)) continue;
    ids.add(child.item.id);
    stack.push(...child.children);
  }
  return ids;
}
