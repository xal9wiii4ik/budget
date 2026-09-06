// `flattenTree` is the one piece of plan logic that exists only on mobile (web
// nests real lists instead), so nothing else pins it. What can genuinely break
// here is the collapse arm — dropping a subtree while keeping its parent's row —
// and the sibling-position flags the reorder buttons are disabled by.
import type { components } from '@budget/api-client';
import { buildTree } from '@budget/api-client';
import { describe, expect, it } from 'vitest';

import { flattenTree } from './flattenTree';

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

// root-a { child-1 { grand }, child-2 }, root-b
const TREE = buildTree([
  item({ id: 'root-a', sort_order: 1024 }),
  item({ id: 'root-b', sort_order: 2048 }),
  item({ id: 'child-1', parent_id: 'root-a', depth: 2, sort_order: 1024 }),
  item({ id: 'child-2', parent_id: 'root-a', depth: 2, sort_order: 2048 }),
  item({ id: 'grand', parent_id: 'child-1', depth: 3, sort_order: 1024 }),
]).roots;

describe('flattenTree', () => {
  it('walks parents before children, in the tree order', () => {
    expect(flattenTree(TREE, new Set()).map((row) => row.node.item.id)).toEqual([
      'root-a',
      'child-1',
      'grand',
      'child-2',
      'root-b',
    ]);
  });

  it('keeps a collapsed node and drops its WHOLE subtree', () => {
    const rows = flattenTree(TREE, new Set(['root-a']));
    expect(rows.map((row) => row.node.item.id)).toEqual(['root-a', 'root-b']);
    expect(rows[0].collapsed).toBe(true);
    expect(rows[0].hasChildren).toBe(true);
  });

  it('marks first/last among SIBLINGS, not in the flattened list', () => {
    const rows = flattenTree(TREE, new Set());
    const byId = new Map(rows.map((row) => [row.node.item.id, row]));
    // 'grand' is an only child: first AND last, though it sits mid-list.
    expect(byId.get('grand')).toMatchObject({ isFirst: true, isLast: true });
    expect(byId.get('child-1')).toMatchObject({ isFirst: true, isLast: false });
    expect(byId.get('child-2')).toMatchObject({ isFirst: false, isLast: true });
    // A collapsed id on a LEAF changes nothing — there is no subtree to hide.
    expect(flattenTree(TREE, new Set(['grand']))).toHaveLength(5);
  });
});
