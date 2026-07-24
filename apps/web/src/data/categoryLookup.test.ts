import { describe, expect, it } from 'vitest';
import type { components } from '@budget/api-client';

import { buildCategoryIndex, sortForDisplay } from './categoryLookup';

type CategoryRead = components['schemas']['CategoryRead'];

function cat(overrides: Partial<CategoryRead> & Pick<CategoryRead, 'id' | 'name' | 'kind'>): CategoryRead {
  return {
    archived: false,
    color: null,
    icon: null,
    is_system: false,
    ...overrides,
  };
}

describe('sortForDisplay', () => {
  it('collates Cyrillic names locale-aware within a kind, unlike the raw order', () => {
    // Raw (server) order: Ёлка before Автобус. Code-point order keeps that (Ё=U+0401
    // sorts before А=U+0410); a locale Collator puts Автобус first. Contrasting the
    // two is what makes this non-vacuous.
    const raw = [
      cat({ id: '1', name: 'Ёлка', kind: 'expense' }),
      cat({ id: '2', name: 'Автобус', kind: 'expense' }),
    ];
    const sorted = sortForDisplay(raw, 'ru');
    expect(sorted.map((c) => c.name)).toEqual(['Автобус', 'Ёлка']);
    // The raw array is untouched (no mutation) and differs from the sorted output.
    expect(raw.map((c) => c.name)).toEqual(['Ёлка', 'Автобус']);
  });

  it('groups all expense categories before income regardless of name', () => {
    const input = [
      cat({ id: '1', name: 'Salary', kind: 'income' }),
      cat({ id: '2', name: 'Zoo', kind: 'expense' }),
    ];
    const sorted = sortForDisplay(input, 'en');
    expect(sorted.map((c) => c.kind)).toEqual(['expense', 'income']);
  });
});

describe('buildCategoryIndex', () => {
  it('includes an archived category so the summary join can still resolve it', () => {
    const archived = cat({ id: 'arch', name: 'Old', kind: 'expense', archived: true });
    const index = buildCategoryIndex([cat({ id: 'a', name: 'Active', kind: 'expense' }), archived]);
    expect(index.get('arch')).toBe(archived);
    expect(index.size).toBe(2);
  });
});
