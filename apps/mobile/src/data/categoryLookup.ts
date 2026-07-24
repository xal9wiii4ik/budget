// Pure category helpers (W3/W11). The server's ORDER BY is determinism only, not a
// display order; the client re-sorts locale-aware, grouped by kind, with an
// Intl.Collator WITHIN each kind group. buildCategoryIndex powers the
// archived-inclusive id -> category join used by the summary/list (W3).
//
// W11 (Hermes VERIFY): RN 0.86 / Expo 57 ship Hermes with Intl (incl. Collator)
// enabled; the on-device probe (lib/probes.ts) records the actual outcome. The
// fallback is ISOLATED here in one function: if Collator is ever absent it degrades
// to localeCompare (also Intl-backed, always present on String.prototype).
import type { components } from '@budget/api-client';

type CategoryRead = components['schemas']['CategoryRead'];

/** id -> category over whatever set is passed (the archived-inclusive one — W3). */
export function buildCategoryIndex(categories: CategoryRead[]): Map<string, CategoryRead> {
  const index = new Map<string, CategoryRead>();
  for (const category of categories) index.set(category.id, category);
  return index;
}

// Expense group first, then income (PM default grouping order).
const KIND_ORDER: Record<CategoryRead['kind'], number> = { expense: 0, income: 1 };

// The single place the W11 fallback lives: prefer Intl.Collator, degrade to
// localeCompare. Constructed once per sort call.
function makeNameComparator(locale?: string): (a: string, b: string) => number {
  if (typeof Intl !== 'undefined' && typeof Intl.Collator === 'function') {
    const collator = new Intl.Collator(locale, { sensitivity: 'base' });
    return (a, b) => collator.compare(a, b);
  }
  return (a, b) => a.localeCompare(b, locale, { sensitivity: 'base' });
}

/**
 * A NEW array sorted by kind group, then locale-aware by name within the group.
 * Does not mutate the input.
 */
export function sortForDisplay(categories: CategoryRead[], locale?: string): CategoryRead[] {
  const compareName = makeNameComparator(locale);
  return [...categories].sort((a, b) => {
    if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    return compareName(a.name, b.name);
  });
}
