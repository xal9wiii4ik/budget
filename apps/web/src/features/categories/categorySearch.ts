// The /categories search filter (search-and-drilldown S2). Pure, so the screen
// keeps only the input's state and the matching rule is testable on its own.
//
// It filters the names ALREADY ON SCREEN: `useCategories`' `select` translates the
// system categories (data/categoryLookup), so a Russian UI matches "прод" against
// "Продукты" — matching the server's English `name` would make the 18 system rows
// unsearchable in exactly the language they are displayed in.
//
// Case folding goes through `toLocaleLowerCase(locale)` for the same reason every
// date and collator in this app takes a locale: the host's default is not the
// user's language. Substring, not fuzzy or word-prefix — the list is ~20-40 rows,
// and "what I typed appears in the name" is the rule a user can predict.
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
