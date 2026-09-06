import { describe, expect, it } from 'vitest';

import type { components } from './generated/schema';
import { buildTree, descendantCount, descendantIds, subtreeSize } from './buildTree';

type GoalItemRead = components['schemas']['GoalItemRead'];

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

describe('buildTree', () => {
  it('nests children under their parent and orders siblings by sort_order, then id', () => {
    const tree = buildTree([
      item({ id: 'b-root', sort_order: 2048 }),
      item({ id: 'a-root', sort_order: 1024 }),
      item({ id: 'child-late', parent_id: 'a-root', sort_order: 2048 }),
      // Same order number as its sibling: the id breaks the tie, so the render
      // order is deterministic instead of "whatever the response happened to be".
      item({ id: 'child-b', parent_id: 'a-root', sort_order: 1024 }),
      item({ id: 'child-a', parent_id: 'a-root', sort_order: 1024 }),
    ]);

    expect(tree.roots.map((node) => node.item.id)).toEqual(['a-root', 'b-root']);
    expect(tree.roots[0].children.map((node) => node.item.id)).toEqual([
      'child-a',
      'child-b',
      'child-late',
    ]);
    expect(subtreeSize(tree.roots[0])).toBe(4);
    expect([...descendantIds(tree.roots[0])].sort()).toEqual([
      'child-a',
      'child-b',
      'child-late',
    ]);
  });

  it('raises a node whose parent is not in the list to the roots instead of dropping it', () => {
    // Losing a row that carries money because its parent is missing is worse
    // than one wrong indent.
    const tree = buildTree([
      item({ id: 'root', sort_order: 1024 }),
      item({ id: 'orphan', parent_id: 'gone', sort_order: 2048 }),
    ]);

    expect(tree.roots.map((node) => node.item.id)).toEqual(['root', 'orphan']);
  });

  it('keeps a parent cycle finite by raising the unreachable nodes to the roots', () => {
    // The DB forbids this (trigger + composite FK); the guard exists so a
    // malformed response cannot render into an infinitely deep tree.
    const tree = buildTree([
      item({ id: 'a', parent_id: 'b', sort_order: 1024 }),
      item({ id: 'b', parent_id: 'a', sort_order: 2048 }),
    ]);

    const ids = tree.roots.map((node) => node.item.id);
    expect(ids).toHaveLength(1);
    expect(subtreeSize(tree.roots[0])).toBe(2);
  });
});

// The delete dialog's number: what goes WITH the node, never the node itself
// (qa F-2 — "delete this leaf? 1 plan item goes with it" invented an item).
describe('descendantCount', () => {
  it('is 0 for a leaf, and counts children and grandchildren for a branch', () => {
    const tree = buildTree([
      item({ id: 'leaf', sort_order: 1024 }),
      item({ id: 'one-child', sort_order: 2048 }),
      item({ id: 'only-child', parent_id: 'one-child', sort_order: 1024 }),
      item({ id: 'deep', sort_order: 3072 }),
      item({ id: 'deep-a', parent_id: 'deep', sort_order: 1024 }),
      item({ id: 'deep-a-1', parent_id: 'deep-a', sort_order: 1024 }),
      item({ id: 'deep-a-2', parent_id: 'deep-a', sort_order: 2048 }),
      item({ id: 'deep-b', parent_id: 'deep', sort_order: 2048 }),
    ]);

    const count = (id: string) => {
      const node = tree.byId.get(id);
      if (!node) throw new Error(`missing node ${id}`);
      return descendantCount(node);
    };

    expect(count('leaf')).toBe(0);
    expect(count('one-child')).toBe(1);
    expect(count('only-child')).toBe(0);
    // Two levels below: both children plus both grandchildren.
    expect(count('deep')).toBe(4);
    expect(count('deep-a')).toBe(2);
  });
});
