// Pure category helpers (obligation C3). The server's ORDER BY is determinism
// only, not a display order; the client re-sorts locale-aware, grouped by kind,
// with an `Intl.Collator` WITHIN each kind group (so Cyrillic Ё/Е etc. collate
// correctly rather than by raw code point). `buildCategoryIndex` powers the
// archived-inclusive id -> category join used by the summary/list (T3).
import type { components } from '@budget/api-client';
import { systemCategoryName, type Lang } from '@budget/shared';

type CategoryRead = components['schemas']['CategoryRead'];

/**
 * The same rows with SYSTEM category names translated (S5). A user's own
 * category and any id this client does not know keep the server's `name`
 * verbatim — a name someone typed is never ours to rewrite.
 *
 * Applied ONCE, in `useCategories`' `select` (data/categories.ts), so every
 * consumer — the pickers, the management screen, the id joins on the list,
 * stats and budgets — reads translated names without a single screen knowing
 * about it, and `sortForDisplay` below collates the names actually shown.
 * The Query CACHE keeps the raw server rows: nothing translated is ever sent
 * back in a PATCH.
 */
export function localizeCategories(categories: CategoryRead[], lang: Lang): CategoryRead[] {
  return categories.map((category) => {
    const name = systemCategoryName(category.id, category.name, lang);
    return name === category.name ? category : { ...category, name };
  });
}

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
