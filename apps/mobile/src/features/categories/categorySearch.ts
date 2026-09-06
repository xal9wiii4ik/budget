// The categories tab's search filter (catch-up 3, line A). COPIED VERBATIM from
// apps/web/src/features/categories/categorySearch.ts — same rule, and its test lives
// there.
//
// It filters the names ALREADY ON SCREEN. Case folding goes through
// `toLocaleLowerCase(locale)` for the same reason every date and collator in this app
// takes a locale: the host's default is not the user's language. Substring, not fuzzy
// or word-prefix — the list is ~20-40 rows, and "what I typed appears in the name" is
// the rule a user can predict.
//
// ONE mobile difference, and it is a fact about this client rather than a change of
// rule: web's `useCategories` translates the system categories in its `select`, so
// web matches "прод" against "Продукты". Mobile has no such select yet, so the names
// here are the server's — a system category is searched in the language the server
// wrote it in, exactly as it is DISPLAYED on this tab. The two stay consistent, which
// is what matters; translating them is a separate change to data/categories.
import type { components } from '@budget/api-client';

type CategoryRead = components['schemas']['CategoryRead'];

export function filterCategories(
  categories: CategoryRead[],
  query: string,
  locale: string,
): CategoryRead[] {
  // Whitespace-only input is not a search: it must not empty the screen.
  const needle = query.trim().toLocaleLowerCase(locale);
  if (needle === '') return categories;
  return categories.filter((category) =>
    category.name.toLocaleLowerCase(locale).includes(needle),
  );
}
