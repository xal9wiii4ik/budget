import { describe, expect, it } from 'vitest';
import type {
  CategoryFormValues,
  GoalFormValues,
  MultiCurrencyTransactionFormValues,
  RecurringTemplateFormValues,
  TransactionFormValues,
} from '@budget/shared';

import {
  buildCategoryPatch,
  buildGoalPatch,
  buildRecurringTemplatePatch,
  buildTransactionPatch,
} from './patch';

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
  account_id: 'acc-usd',
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

  // --- transaction-details-and-i18n S1: the original (spent) pair -----------
  // A BYN card charged 165.00 for a 50.00 EUR purchase.
  const withOriginal: MultiCurrencyTransactionFormValues = {
    ...baseMultiCurrency,
    account_id: 'acc-byn',
    amount: 16500,
    currency: 'BYN',
    base_amount_minor: null,
    original_amount_minor: 5000,
    original_currency: 'EUR',
  };

  it('emits the original pair ATOMICALLY — never one member alone', () => {
    // Unchanged: neither key.
    expect(buildTransactionPatch(withOriginal, withOriginal, 'RUB')).toEqual({});

    // Only the spent AMOUNT moved: the currency travels with it anyway, because
    // half a pair is 422 ORIGINAL_FIELDS_REQUIRED on the wire.
    const amountOnly = buildTransactionPatch(
      { ...withOriginal, original_amount_minor: 5500 },
      withOriginal,
      'RUB',
    );
    expect(amountOnly).toEqual({ original_amount_minor: 5500, original_currency: 'EUR' });

    // Only the spent CURRENCY moved: same rule, mirrored.
    const currencyOnly = buildTransactionPatch(
      { ...withOriginal, original_currency: 'USD' },
      withOriginal,
      'RUB',
    );
    expect(currencyOnly).toEqual({ original_amount_minor: 5000, original_currency: 'USD' });

    // Cleared (the spend currency was set back to the account's): BOTH null, and
    // NOT a re-send of amount_minor — the charge stays the source of truth.
    const cleared = buildTransactionPatch(
      { ...withOriginal, original_amount_minor: null, original_currency: null },
      withOriginal,
      'RUB',
    );
    expect(cleared).toEqual({ original_amount_minor: null, original_currency: null });
  });

  it('omits amount_minor when the charged field is blank (server recomputes)', () => {
    // The user edited what they SPENT and left "charged to the account" empty:
    // resending the stale charge would pin the old rate, so the key is dropped
    // and the pair alone asks the server to recompute (PATCH row 4).
    const patch = buildTransactionPatch(
      { ...withOriginal, amount: null, original_amount_minor: 5500 },
      withOriginal,
      'RUB',
    );
    expect(patch).toEqual({ original_amount_minor: 5500, original_currency: 'EUR' });
    expect('amount_minor' in patch).toBe(false);
  });

  it('applies the clearable trichotomy to country', () => {
    const withCountry: MultiCurrencyTransactionFormValues = { ...withOriginal, country: 'DE' };
    expect('country' in buildTransactionPatch(withCountry, withCountry, 'RUB')).toBe(false);
    expect(buildTransactionPatch({ ...withCountry, country: 'FR' }, withCountry, 'RUB')).toEqual({
      country: 'FR',
    });
    expect(buildTransactionPatch({ ...withCountry, country: '' }, withCountry, 'RUB')).toEqual({
      country: null,
    });
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

// A monthly template as the edit form loads it (schema OUTPUT shape).
const baseTemplate: RecurringTemplateFormValues = {
  name: 'Rent',
  account_id: 'acc-1',
  amount_minor: 5_000_000,
  kind: 'expense',
  currency: 'RUB',
  category_id: 'cat-1',
  merchant: 'Landlord',
  note: 'flat',
  interval_unit: 'month',
  day_of_month: 5,
  weekday: null,
  start_date: '2026-09-01',
  end_date: '2027-01-01',
};

describe('buildRecurringTemplatePatch', () => {
  it('omits every unchanged field (no-op edit -> {})', () => {
    expect(buildRecurringTemplatePatch(baseTemplate, baseTemplate)).toEqual({});
  });

  it('emits only day_of_month when the unit stays monthly and the day moves', () => {
    const patch = buildRecurringTemplatePatch(
      { ...baseTemplate, day_of_month: 12 },
      baseTemplate,
    );
    expect(patch).toEqual({ day_of_month: 12 });
    // The non-matching anchor key is absent ENTIRELY — not present as null.
    expect('weekday' in patch).toBe(false);
    expect('interval_unit' in patch).toBe(false);
  });

  it('on month -> week emits the new unit + weekday and NO stale day_of_month', () => {
    // The arm a naive field diff fails: it would resend day_of_month: 5 next to
    // weekday: 2 and collect an ANCHOR_MISMATCH.
    const patch = buildRecurringTemplatePatch(
      { ...baseTemplate, interval_unit: 'week', day_of_month: null, weekday: 2 },
      baseTemplate,
    );
    expect(patch).toEqual({ interval_unit: 'week', weekday: 2 });
    expect('day_of_month' in patch).toBe(false);
  });

  it('re-emits the anchor on a unit switch even when its stored value is unchanged', () => {
    // week -> month where day_of_month never moved: the server still needs it
    // (ANCHOR_REQUIRED), so "unchanged" is not "omit" here.
    const weekly: RecurringTemplateFormValues = {
      ...baseTemplate,
      interval_unit: 'week',
      day_of_month: null,
      weekday: 2,
    };
    const patch = buildRecurringTemplatePatch(
      { ...weekly, interval_unit: 'month', day_of_month: 5, weekday: null },
      { ...weekly, day_of_month: 5 },
    );
    expect(patch).toEqual({ interval_unit: 'month', day_of_month: 5 });
    expect('weekday' in patch).toBe(false);
  });

  it('does not re-emit the anchor when only the amount changed', () => {
    const patch = buildRecurringTemplatePatch(
      { ...baseTemplate, amount_minor: 5_500_000 },
      baseTemplate,
    );
    expect(patch).toEqual({ amount_minor: 5_500_000 });
  });

  it('omits start_date when it did not change, and emits an explicit null when cleared', () => {
    // The two arms A4 gives different MEANINGS to: omitting the key keeps the
    // stored seed, while an explicit null rewinds the template to its natural
    // schedule. A diff bug here is a watermark bug, not a cosmetic one.
    expect('start_date' in buildRecurringTemplatePatch(baseTemplate, baseTemplate)).toBe(false);

    const cleared = buildRecurringTemplatePatch(
      { ...baseTemplate, start_date: null },
      baseTemplate,
    );
    expect(cleared).toEqual({ start_date: null });
    expect(cleared.start_date).toBeNull();

    const moved = buildRecurringTemplatePatch(
      { ...baseTemplate, start_date: '2026-10-01' },
      baseTemplate,
    );
    expect(moved).toEqual({ start_date: '2026-10-01' });
  });

  it('applies the clearable trichotomy to category_id / merchant / note / end_date', () => {
    const cleared = buildRecurringTemplatePatch(
      { ...baseTemplate, category_id: '', merchant: '', note: '', end_date: null },
      baseTemplate,
    );
    expect(cleared).toEqual({
      category_id: null,
      merchant: null,
      note: null,
      end_date: null,
    });

    const changed = buildRecurringTemplatePatch(
      {
        ...baseTemplate,
        category_id: 'cat-2',
        merchant: 'Agency',
        note: 'new flat',
        end_date: '2028-06-30',
      },
      baseTemplate,
    );
    expect(changed).toEqual({
      category_id: 'cat-2',
      merchant: 'Agency',
      note: 'new flat',
      end_date: '2028-06-30',
    });
  });

  it('never emits null for name / currency / kind (the *_REQUIRED family)', () => {
    const patch = buildRecurringTemplatePatch(
      { ...baseTemplate, name: 'Rent 2', currency: 'EUR', kind: 'income' },
      baseTemplate,
    );
    expect(patch).toEqual({ name: 'Rent 2', currency: 'EUR', kind: 'income' });
  });

  it('never emits `paused` — pause/resume is its own one-field PATCH', () => {
    const patch = buildRecurringTemplatePatch({ ...baseTemplate, name: 'Rent 2' }, baseTemplate);
    expect('paused' in patch).toBe(false);
  });
});
