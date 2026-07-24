import { describe, expect, it } from 'vitest';
import type { CategoryFormValues, TransactionFormValues } from '@budget/shared';

import { buildCategoryPatch, buildTransactionPatch } from './patch';

const baseCategory: CategoryFormValues = {
  name: 'Groceries',
  kind: 'expense',
  icon: '🛒',
  color: '#3366ff',
};

const baseTransaction: TransactionFormValues = {
  amount: 1250,
  kind: 'expense',
  category_id: 'cat-1',
  occurred_at: '2026-07-24',
  note: 'lunch',
};

describe('buildCategoryPatch', () => {
  it('omits every unchanged field (no-op edit -> {})', () => {
    expect(buildCategoryPatch(baseCategory, baseCategory)).toEqual({});
  });

  it('emits null when a clearable field (icon) is cleared to ""', () => {
    const patch = buildCategoryPatch({ ...baseCategory, icon: '' }, baseCategory);
    expect(patch).toEqual({ icon: null });
    expect(patch.icon).toBeNull();
  });

  it('never emits null for the non-nullable name field', () => {
    const patch = buildCategoryPatch({ ...baseCategory, name: 'Food' }, baseCategory);
    expect(patch).toEqual({ name: 'Food' });
  });

  it('does not resend color on a case-only difference (C7)', () => {
    const patch = buildCategoryPatch({ ...baseCategory, color: '#3366FF' }, baseCategory);
    expect(patch).toEqual({});
  });

  it('emits only the touched fields when several change', () => {
    const patch = buildCategoryPatch(
      { ...baseCategory, name: 'Food', color: '' },
      baseCategory,
    );
    expect(patch).toEqual({ name: 'Food', color: null });
  });
});

describe('buildTransactionPatch', () => {
  it('omits every unchanged field (no-op edit -> {})', () => {
    expect(buildTransactionPatch(baseTransaction, baseTransaction)).toEqual({});
  });

  it('emits null when category_id and note are cleared to ""', () => {
    const patch = buildTransactionPatch(
      { ...baseTransaction, category_id: '', note: '' },
      baseTransaction,
    );
    expect(patch).toEqual({ category_id: null, note: null });
  });

  it('never emits null for amount_minor / kind / occurred_at', () => {
    const patch = buildTransactionPatch(
      { ...baseTransaction, amount: 2000, kind: 'income', occurred_at: '2026-08-01' },
      baseTransaction,
    );
    expect(patch).toEqual({
      amount_minor: 2000,
      kind: 'income',
      occurred_at: '2026-08-01',
    });
  });

  it('includes only the touched field (amount) and nothing else', () => {
    const patch = buildTransactionPatch({ ...baseTransaction, amount: 999 }, baseTransaction);
    expect(patch).toEqual({ amount_minor: 999 });
  });
});
