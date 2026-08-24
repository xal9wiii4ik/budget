import { describe, expect, it } from 'vitest';

import type { GoalItemRead } from '../../../data/goalItems';
import { moveTargets } from './moveTargets';

function item(id: string, parentId: string | null, depth: number): GoalItemRead {
  return {
    id,
    goal_id: 'goal-1',
    parent_id: parentId,
    name: id,
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
    // The SERVER's level (roots = 1) — never recomputed by the client.
    depth,
    sort_order: 1024,
    files_count: 0,
    subtree_files_count: 0,
    created_at: '2026-08-01T00:00:00Z',
  };
}

// trip
//  ├─ stay          (depth 2)
//  │   └─ hotel     (depth 3)
//  └─ tickets       (depth 2)
const TREE: GoalItemRead[] = [
  item('trip', null, 1),
  item('stay', 'trip', 2),
  item('hotel', 'stay', 3),
  item('tickets', 'trip', 2),
];

describe('moveTargets', () => {
  it('offers neither the node itself nor any of its descendants', () => {
    expect(moveTargets(TREE, 'stay').map((target) => target.id)).toEqual(['trip', 'tickets']);
  });

  it('drops targets that cannot hold the moved SUBTREE within the depth limit', () => {
    // A chain six levels deep: moving `stay` (a two-level subtree) under level 5
    // would land `hotel` on level 7 — the server's own refusal
    // (GOAL_ITEM_DEPTH_EXCEEDED), so the option is never offered.
    const deep: GoalItemRead[] = [
      ...TREE,
      item('l1', null, 1),
      item('l2', 'l1', 2),
      item('l3', 'l2', 3),
      item('l4', 'l3', 4),
      item('l5', 'l4', 5),
    ];

    const ids = moveTargets(deep, 'stay').map((target) => target.id);
    expect(ids).toContain('l4');
    expect(ids).not.toContain('l5');
  });

  it('lets a LEAF go one level deeper than a two-level subtree may', () => {
    const deep: GoalItemRead[] = [
      item('l1', null, 1),
      item('l2', 'l1', 2),
      item('l3', 'l2', 3),
      item('l4', 'l3', 4),
      item('l5', 'l4', 5),
      item('leaf', null, 1),
    ];

    expect(moveTargets(deep, 'leaf').map((target) => target.id)).toContain('l5');
  });
});
