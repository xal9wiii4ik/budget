import { describe, expect, it } from 'vitest';
import type {
  CategoryFormValues,
  GoalFormValues,
  MultiCurrencyTransactionFormValues,
  TransactionFormValues,
} from '@budget/shared';

import { buildCategoryPatch, buildGoalPatch, buildTransactionPatch } from './patch';

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

// --- 3.2 multi-currency arm (W1 / WD-3) ------------------------------------
// Base currency is RUB throughout; the transaction is a foreign (USD) row that
// already carries a user-owned override of 90.00 RUB.
const baseMultiCurrency: MultiCurrencyTransactionFormValues = {
  amount: 1250,
  currency: 'USD',
  base_amount_minor: 9000,
  kind: 'expense',
  category_id: 'cat-1',
  occurred_at: '2026-07-24',
  note: 'lunch',
  // Create-only field (the receipts confirm form): PATCH never learns from a
  // merchant (D7), so the builder emits no key for it — see the test below.
  merchant: '',
};

describe('buildTransactionPatch (multi-currency)', () => {
  it('applies the omitted/null/value trichotomy to base_amount_minor', () => {
    // One initial state (a stored override), three user actions.
    const untouched = buildTransactionPatch(baseMultiCurrency, baseMultiCurrency, 'RUB');
    expect('base_amount_minor' in untouched).toBe(false);

    const edited = buildTransactionPatch(
      { ...baseMultiCurrency, base_amount_minor: 9500 },
      baseMultiCurrency,
      'RUB',
    );
    expect(edited).toEqual({ base_amount_minor: 9500 });

    // "Reset to auto" -> "" -> null: discard the override and let the server
    // recompute (PATCH row 5), NOT "no rate exists".
    const cleared = buildTransactionPatch(
      { ...baseMultiCurrency, base_amount_minor: null },
      baseMultiCurrency,
      'RUB',
    );
    expect(cleared).toEqual({ base_amount_minor: null });
    expect(cleared.base_amount_minor).toBeNull();
  });

  it('emits a changed currency and omits an unchanged one', () => {
    expect(
      buildTransactionPatch({ ...baseMultiCurrency, currency: 'EUR' }, baseMultiCurrency, 'RUB'),
    ).toEqual({ currency: 'EUR' });
    expect(buildTransactionPatch(baseMultiCurrency, baseMultiCurrency, 'RUB')).toEqual({});
  });

  it('drops base_amount_minor when the currency changes TO the base currency', () => {
    // The one body that would 422 (BASE_AMOUNT_WITHOUT_CURRENCY): currency -> RUB
    // while a value still sits in the converted field. Only `currency` is emitted.
    const patch = buildTransactionPatch(
      { ...baseMultiCurrency, currency: 'RUB', base_amount_minor: 9000 },
      baseMultiCurrency,
      'RUB',
    );
    expect(patch).toEqual({ currency: 'RUB' });
  });

  it('does not send a bare clear when there was no stored override', () => {
    // No snapshot initially ("" -> null) and still "" -> nothing to discard.
    const noSnapshot: MultiCurrencyTransactionFormValues = {
      ...baseMultiCurrency,
      base_amount_minor: null,
    };
    expect(buildTransactionPatch(noSnapshot, noSnapshot, 'RUB')).toEqual({});
  });

  it('never emits a merchant key, even when the form value differs (S6)', () => {
    // The edit form renders no merchant input, so its value is always "" while a
    // receipt-confirmed row HAS a stored merchant. Diffing it would silently
    // clear that column on every unrelated edit — and PATCH must not learn from a
    // merchant either (D7). Contrast: the same diff still emits the note change.
    const patch = buildTransactionPatch(
      { ...baseMultiCurrency, merchant: '', note: 'dinner' },
      { ...baseMultiCurrency, merchant: 'Corner Shop' },
      'RUB',
    );
    expect(patch).toEqual({ note: 'dinner' });
  });

  it('still builds the pre-3.2 single-currency patch from the 2-arg call (mobile freeze)', () => {
    const patch = buildTransactionPatch({ ...baseTransaction, amount: 999 }, baseTransaction);
    expect(patch).toEqual({ amount_minor: 999 });
    expect('currency' in patch).toBe(false);
    expect('base_amount_minor' in patch).toBe(false);
  });
});

describe('buildGoalPatch', () => {
  const baseGoal: GoalFormValues = {
    name: 'New laptop',
    target_minor: 200000,
    currency: 'USD',
    deadline: '2026-12-31',
    priority: 2,
    initial_saved_minor: null,
  };

  it('omits every unchanged field (no-op edit -> {})', () => {
    expect(buildGoalPatch(baseGoal, baseGoal)).toEqual({});
  });

  it('applies the omitted/null/value trichotomy to deadline', () => {
    // One initial state (a goal WITH a deadline), three user actions.
    expect('deadline' in buildGoalPatch(baseGoal, baseGoal)).toBe(false);

    const moved = buildGoalPatch({ ...baseGoal, deadline: '2027-06-30' }, baseGoal);
    expect(moved).toEqual({ deadline: '2027-06-30' });

    // Cleared: an explicit null tells the server to drop the deadline. The key
    // must be PRESENT and null — an omitted key would silently keep it.
    const cleared = buildGoalPatch({ ...baseGoal, deadline: null }, baseGoal);
    expect(cleared).toEqual({ deadline: null });
    expect(cleared.deadline).toBeNull();
  });

  it('never emits null for the NOT NULL fields (name / target / currency)', () => {
    const patch = buildGoalPatch(
      { ...baseGoal, name: 'Laptop', target_minor: 250000, currency: 'EUR' },
      baseGoal,
    );
    expect(patch).toEqual({ name: 'Laptop', target_minor: 250000, currency: 'EUR' });
  });

  it('emits a changed priority but omits a BLANKED one (no PRIORITY_REQUIRED 422)', () => {
    expect(buildGoalPatch({ ...baseGoal, priority: 5 }, baseGoal)).toEqual({ priority: 5 });
    // "" -> null on an edit means "leave the stored priority alone": there is
    // nothing to append-last to, and null would be rejected by the server.
    expect(buildGoalPatch({ ...baseGoal, priority: null }, baseGoal)).toEqual({});
  });

  it('never carries initial_saved_minor or archived into a patch', () => {
    const patch = buildGoalPatch({ ...baseGoal, initial_saved_minor: 50000 }, baseGoal);
    expect(patch).toEqual({});
    expect('archived' in patch).toBe(false);
  });
});
