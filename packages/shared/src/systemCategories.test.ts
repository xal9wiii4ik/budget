import { describe, expect, it } from 'vitest';

import { systemCategoryName } from './systemCategories';

// "Продукты" — the frozen seed id from migration 0003 (conventions.md).
const GROCERIES = 'ce814749-2554-40be-8952-3a63d505694f';

describe('systemCategoryName', () => {
  it('translates a frozen system id and keeps the ru name identical to the seed row', () => {
    // The contrast is the point: the SAME id must read differently per language,
    // and the ru side must stay byte-identical to what the database stores — a
    // "translation" that drifts from the seed name would silently rename a
    // category for every ru user.
    expect(systemCategoryName(GROCERIES, 'Продукты', 'en')).toBe('Groceries');
    expect(systemCategoryName(GROCERIES, 'Продукты', 'ru')).toBe('Продукты');
  });

  it('renders an unknown id with the server name, never a placeholder', () => {
    // A user's own category and a seed row added after this table was written are
    // the same case: the server name is the truth, in BOTH languages. No "Unknown".
    const userId = '11111111-2222-3333-4444-555555555555';
    expect(systemCategoryName(userId, 'Кошачий корм', 'en')).toBe('Кошачий корм');
    expect(systemCategoryName(userId, 'Кошачий корм', 'ru')).toBe('Кошачий корм');
  });
});
