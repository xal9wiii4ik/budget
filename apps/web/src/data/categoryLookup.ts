// Pure category helpers (obligation C3). The server's ORDER BY is determinism
// only, not a display order; the client re-sorts locale-aware, grouped by kind,
// with an `Intl.Collator` WITHIN each kind group (so Cyrillic Ё/Е etc. collate
// correctly rather than by raw code point). `buildCategoryIndex` powers the
// archived-inclusive id -> category join used by the summary/list (T3).
import type { components } from '@budget/api-client';

type CategoryRead = components['schemas']['CategoryRead'];

/** id -> category over whatever set is passed (the archived-inclusive one — T3). */
export function buildCategoryIndex(categories: CategoryRead[]): Map<string, CategoryRead> {
  const index = new Map<string, CategoryRead>();
  for (const category of categories) index.set(category.id, category);
  return index;
}

// Expense group first, then income (PM default Q1 grouping order).
const KIND_ORDER: Record<CategoryRead['kind'], number> = { expense: 0, income: 1 };

/**
 * A NEW array sorted by kind group, then locale-aware by name within the group.
 * Does not mutate the input.
 */
export function sortForDisplay(categories: CategoryRead[], locale?: string): CategoryRead[] {
  const collator = new Intl.Collator(locale, { sensitivity: 'base' });
  return [...categories].sort((a, b) => {
    if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    return collator.compare(a.name, b.name);
  });
}
