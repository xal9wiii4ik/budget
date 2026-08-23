import type { components } from '@budget/api-client';
import { describe, expect, it } from 'vitest';

import { filterCategories } from './categorySearch';

type CategoryRead = components['schemas']['CategoryRead'];

function category(name: string): CategoryRead {
  return {
    id: `cat-${name}`,
    name,
    kind: 'expense',
    icon: null,
    color: null,
    is_system: true,
    archived: false,
  };
}

describe('filterCategories', () => {
  it('matches a Cyrillic substring regardless of case', () => {
    // The reason this is not `String.prototype.toLowerCase`: the user searching is
    // the Russian one, typing "ПРОД" into a screen whose system rows are shown
    // translated. Both sides fold, in the user's locale, or the 18 system
    // categories are unsearchable in the language they are displayed in.
    const rows = [category('Продукты'), category('Транспорт'), category('Groceries')];

    expect(filterCategories(rows, 'ПРОД', 'ru-RU').map((row) => row.name)).toEqual([
      'Продукты',
    ]);
    expect(filterCategories(rows, 'roc', 'ru-RU').map((row) => row.name)).toEqual([
      'Groceries',
    ]);
    // Whitespace-only input is not a search: it must not empty the screen.
    expect(filterCategories(rows, '   ', 'ru-RU')).toEqual(rows);
    expect(filterCategories(rows, 'нет такого', 'ru-RU')).toEqual([]);
  });
});
