import { describe, it, expect } from 'vitest';
import { toSignedInputString } from './money';
import {
  accountFormSchema,
  categoryFormSchema,
  categoryLimitFormSchema,
  contributionFormSchema,
  currencyCodeSchema,
  goalFormSchema,
  moneyAmountSchema,
  multiCurrencyTransactionFormSchema,
  recurringTemplateFormSchema,
  signedAmountMinor,
} from './schemas';

// Thin-wrapper tests: prove the zod wiring, don't re-enumerate parseMoney cases.
describe('moneyAmountSchema', () => {
  it('transforms a valid string to minor units', () => {
    expect(moneyAmountSchema('USD').parse('12.50')).toBe(1250);
  });

  it('surfaces a parse failure as a zod issue carrying params.reason (AM4 contract)', () => {
    const result = moneyAmountSchema('USD').safeParse('12.505');
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    const issue = result.error.issues[0];
    // The client contract is the machine-readable reason, not the message text.
    expect((issue as { params?: { reason?: string } }).params?.reason).toBe('too-many-decimals');
  });

  it('threads the currency into the exponent check', () => {
    // "1.5" is fine for USD (exp 2) but too precise for JPY (exp 0).
    expect(moneyAmountSchema('USD').parse('1.50')).toBe(150);
    expect(moneyAmountSchema('JPY').safeParse('1.5').success).toBe(false);
  });
});

describe('categoryFormSchema color refine', () => {
  const base = { name: 'Groceries', kind: 'expense' as const, icon: '' };

  it('accepts empty (optional), rejects bad hex, accepts valid mixed-case hex', () => {
    // Empty is the optional-color arm (mobile 1.8 reuses it) — must pass.
    expect(categoryFormSchema.safeParse({ ...base, color: '' }).success).toBe(true);
    // A non-hex value must be rejected...
    expect(categoryFormSchema.safeParse({ ...base, color: 'red' }).success).toBe(false);
    // ...while a valid 6-digit hex in mixed case passes (C7: case-insensitive).
    expect(categoryFormSchema.safeParse({ ...base, color: '#3aF6bC' }).success).toBe(true);
  });
});

describe('currencyCodeSchema', () => {
  it('accepts a well-formed code and rejects malformed shapes', () => {
    expect(currencyCodeSchema.parse('USD')).toBe('USD');
    expect(currencyCodeSchema.safeParse('usd').success).toBe(false);
    expect(currencyCodeSchema.safeParse('US').success).toBe(false);
    expect(currencyCodeSchema.safeParse('DOLLAR').success).toBe(false);
  });
});

// --- multiCurrencyTransactionFormSchema (3.2 W1 / WD-2) --------------------
// The named risk is a fixed-exponent regression: parsing `amount` against the
// BASE currency (or a constructor argument) instead of the SELECTED one, and
// vice-versa for `base_amount`. Every case below contrasts the two currencies.
describe('multiCurrencyTransactionFormSchema', () => {
  const input = {
    account_id: 'acc-1',
    amount: '10',
    currency: 'USD',
    base_amount: '',
    kind: 'expense' as const,
    category_id: '',
    occurred_at: '2026-08-15',
    note: '',
  };

  it('parses `amount` with the SELECTED currency exponent, not a fixed one', () => {
    // Same schema instance (base RUB), same input string, two selected currencies.
    const schema = multiCurrencyTransactionFormSchema('RUB');
    const usd = schema.safeParse({ ...input, amount: '12.50', currency: 'USD' });
    expect(usd.success && usd.data.amount).toBe(1250);

    const jpy = schema.safeParse({ ...input, amount: '12.50', currency: 'JPY' });
    expect(jpy.success).toBe(false);
    if (jpy.success) throw new Error('expected failure');
    const issue = jpy.error.issues[0];
    expect(issue.path).toEqual(['amount']);
    expect((issue as { params?: { reason?: string } }).params?.reason).toBe('too-many-decimals');
  });

  it('parses `base_amount` with the BASE currency exponent, not the selected one', () => {
    // Base JPY (exp 0), selected USD (exp 2): "1200" is 1200 yen...
    const schema = multiCurrencyTransactionFormSchema('JPY');
    const ok = schema.safeParse({ ...input, currency: 'USD', base_amount: '1200' });
    expect(ok.success && ok.data.base_amount_minor).toBe(1200);

    // ...and a 2-decimal string is invalid for the base currency (would have been
    // accepted had it been parsed against the selected USD).
    const bad = schema.safeParse({ ...input, currency: 'USD', base_amount: '12.50' });
    expect(bad.success).toBe(false);
    if (bad.success) throw new Error('expected failure');
    expect(bad.error.issues[0].path).toEqual(['base_amount']);
  });

  it('nulls base_amount_minor when the selected currency IS the base currency', () => {
    // Even with a non-empty string left in the (hidden) field: the
    // BASE_AMOUNT_WITHOUT_CURRENCY guard starts at the schema.
    const schema = multiCurrencyTransactionFormSchema('USD');
    const result = schema.safeParse({ ...input, currency: 'USD', base_amount: '99.00' });
    expect(result.success && result.data.base_amount_minor).toBeNull();
  });

  it('maps an empty base_amount to null (the auto sentinel) under a foreign currency', () => {
    const schema = multiCurrencyTransactionFormSchema('RUB');
    const result = schema.safeParse({ ...input, currency: 'USD', base_amount: '' });
    expect(result.success && result.data.base_amount_minor).toBeNull();
  });

  it('accepts an out-of-set currency code (picker gates, validation does not)', () => {
    // WD-2: z.enum(SUPPORTED_CURRENCIES) would reject a JPY receipt the server
    // accepts. Contrast arm: a malformed shape is still rejected.
    const schema = multiCurrencyTransactionFormSchema('RUB');
    const jpy = schema.safeParse({ ...input, amount: '1200', currency: 'JPY' });
    expect(jpy.success && jpy.data.currency).toBe('JPY');
    expect(schema.safeParse({ ...input, currency: 'usd' }).success).toBe(false);
  });
});

describe('goalFormSchema (3.2 W3)', () => {
  const input = {
    name: 'New laptop',
    target: '1000',
    currency: 'USD',
    deadline: '',
    priority: '',
    initial_saved: '',
  };

  it('parses `target` with the SELECTED currency exponent', () => {
    const usd = goalFormSchema.safeParse({ ...input, target: '12.50', currency: 'USD' });
    expect(usd.success && usd.data.target_minor).toBe(1250);

    // Contrast arm: the same string under a 0-exponent currency is invalid, which
    // a fixed-exponent schema would have silently accepted as 1250 yen.
    const jpy = goalFormSchema.safeParse({ ...input, target: '12.50', currency: 'JPY' });
    expect(jpy.success).toBe(false);
    if (jpy.success) throw new Error('expected failure');
    const issue = jpy.error.issues[0];
    expect(issue.path).toEqual(['target']);
    expect((issue as { params?: { reason?: string } }).params?.reason).toBe('too-many-decimals');
  });

  it('rejects a zero target (mirrors the server ge=1) on the target field', () => {
    const result = goalFormSchema.safeParse({ ...input, target: '0' });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error.issues[0].path).toEqual(['target']);
  });

  it('maps the empty sentinels to null (deadline / priority / initial_saved)', () => {
    const result = goalFormSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.data.deadline).toBeNull();
    expect(result.data.priority).toBeNull();
    expect(result.data.initial_saved_minor).toBeNull();
  });

  it('parses `initial_saved` with the selected currency and rejects zero', () => {
    const ok = goalFormSchema.safeParse({ ...input, currency: 'JPY', initial_saved: '500' });
    expect(ok.success && ok.data.initial_saved_minor).toBe(500); // exponent 0

    const zero = goalFormSchema.safeParse({ ...input, initial_saved: '0.00' });
    expect(zero.success).toBe(false);
    if (zero.success) throw new Error('expected failure');
    expect(zero.error.issues[0].path).toEqual(['initial_saved']);
  });

  it('accepts a whole-number priority and rejects a non-numeric one', () => {
    const ok = goalFormSchema.safeParse({ ...input, priority: '3' });
    expect(ok.success && ok.data.priority).toBe(3);

    const bad = goalFormSchema.safeParse({ ...input, priority: '1.5' });
    expect(bad.success).toBe(false);
    if (bad.success) throw new Error('expected failure');
    expect(bad.error.issues[0].path).toEqual(['priority']);
  });

  it('keeps a well-formed deadline and rejects a malformed one', () => {
    const ok = goalFormSchema.safeParse({ ...input, deadline: '2026-12-31' });
    expect(ok.success && ok.data.deadline).toBe('2026-12-31');

    const bad = goalFormSchema.safeParse({ ...input, deadline: '31/12/2026' });
    expect(bad.success).toBe(false);
    if (bad.success) throw new Error('expected failure');
    expect(bad.error.issues[0].path).toEqual(['deadline']);
  });
});

describe('contributionFormSchema (3.2 W4)', () => {
  const input = {
    amount: '25',
    direction: 'add' as const,
    occurred_at: '2026-08-15',
    note: '',
  };

  it('collects a MAGNITUDE: the direction never makes the amount negative', () => {
    const schema = contributionFormSchema('USD');
    const withdraw = schema.safeParse({ ...input, direction: 'withdraw', amount: '25' });
    expect(withdraw.success && withdraw.data.amount).toBe(2500);
    expect(withdraw.success && withdraw.data.direction).toBe('withdraw');
  });

  it('rejects a typed minus sign on the amount field (sign belongs to direction)', () => {
    const result = contributionFormSchema('USD').safeParse({ ...input, amount: '-5' });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    const issue = result.error.issues[0];
    expect(issue.path).toEqual(['amount']);
    expect((issue as { params?: { reason?: string } }).params?.reason).toBe('negative');
  });

  it('rejects a zero amount (the server rejects amount_minor == 0)', () => {
    const result = contributionFormSchema('USD').safeParse({ ...input, amount: '0' });
    expect(result.success).toBe(false);
  });

  it('parses the amount with the GOAL currency exponent', () => {
    expect(contributionFormSchema('JPY').safeParse({ ...input, amount: '500' }).success).toBe(
      true,
    );
    // 2 decimals are meaningless for an exponent-0 currency.
    expect(contributionFormSchema('JPY').safeParse({ ...input, amount: '5.00' }).success).toBe(
      false,
    );
  });
});

describe('signedAmountMinor', () => {
  it('leaves an add positive and makes a withdrawal negative', () => {
    expect(signedAmountMinor('add', 2500)).toBe(2500);
    expect(signedAmountMinor('withdraw', 2500)).toBe(-2500);
  });
});

describe('recurringTemplateFormSchema (5.3 W2)', () => {
  const schema = recurringTemplateFormSchema();
  const input = {
    name: 'Rent',
    account_id: 'acc-1',
    amount: '50000',
    currency: 'RUB',
    kind: 'expense' as const,
    category_id: 'cat-1',
    merchant: '',
    note: '',
    interval_unit: 'month' as const,
    day_of_month: '5',
    weekday: '',
    start_date: '',
    end_date: '',
  };

  it('requires day_of_month for a MONTHLY template, and accepts it when present', () => {
    const missing = schema.safeParse({ ...input, day_of_month: '' });
    expect(missing.success).toBe(false);
    expect(missing.error?.issues.map((issue) => issue.path)).toContainEqual(['day_of_month']);

    const present = schema.safeParse(input);
    expect(present.success).toBe(true);
    expect(present.data?.day_of_month).toBe(5);
  });

  it('requires weekday for a WEEKLY template', () => {
    const missing = schema.safeParse({
      ...input,
      interval_unit: 'week',
      day_of_month: '',
      weekday: '',
    });
    expect(missing.success).toBe(false);
    expect(missing.error?.issues.map((issue) => issue.path)).toContainEqual(['weekday']);

    const present = schema.safeParse({
      ...input,
      interval_unit: 'week',
      day_of_month: '',
      weekday: '0',
    });
    expect(present.success).toBe(true);
    // ISO 0 = Monday travels through unchanged (R1): no re-basing anywhere.
    expect(present.data?.weekday).toBe(0);
  });

  it('drops the anchor the effective unit does not use (mirrors the DB CHECK)', () => {
    // A stale weekday left in the hidden control by a week->month switch: sending
    // it is exactly what the server answers with ANCHOR_MISMATCH.
    const monthly = schema.safeParse({ ...input, weekday: '3' });
    expect(monthly.success).toBe(true);
    expect(monthly.data?.weekday).toBeNull();
    expect(monthly.data?.day_of_month).toBe(5);

    const weekly = schema.safeParse({
      ...input,
      interval_unit: 'week',
      day_of_month: '5',
      weekday: '3',
    });
    expect(weekly.success).toBe(true);
    expect(weekly.data?.day_of_month).toBeNull();
    expect(weekly.data?.weekday).toBe(3);
  });

  it('parses `amount` with the SELECTED currency exponent, not a base-bound one', () => {
    // The 100x contrast: the same input string is two different amounts.
    expect(schema.safeParse({ ...input, amount: '5000', currency: 'JPY' }).data?.amount_minor).toBe(
      5000,
    );
    expect(schema.safeParse({ ...input, amount: '50.00', currency: 'RUB' }).data?.amount_minor).toBe(
      5000,
    );
    // 2 decimals are meaningless for an exponent-0 currency.
    expect(schema.safeParse({ ...input, amount: '50.00', currency: 'JPY' }).success).toBe(false);
  });

  it('rejects a zero amount (mirrors the server ge=1) on the amount field', () => {
    const result = schema.safeParse({ ...input, amount: '0' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['amount']);
    expect(schema.safeParse({ ...input, amount: '0.01' }).data?.amount_minor).toBe(1);
  });

  it('maps an empty start_date to null and reports start > end on the start field', () => {
    expect(schema.safeParse(input).data?.start_date).toBeNull();
    expect(schema.safeParse({ ...input, start_date: '2026-09-01' }).data?.start_date).toBe(
      '2026-09-01',
    );

    const inverted = schema.safeParse({
      ...input,
      start_date: '2027-02-01',
      end_date: '2026-12-31',
    });
    expect(inverted.success).toBe(false);
    expect(inverted.error?.issues.map((issue) => issue.path)).toContainEqual(['start_date']);

    // Strictly after: start == end is a one-off charge, exactly as the server reads it.
    expect(
      schema.safeParse({ ...input, start_date: '2026-12-31', end_date: '2026-12-31' }).success,
    ).toBe(true);
  });

  it('floors start_date only when a minimum is supplied (create), never on edit', () => {
    // CREATE passes today: a past start is 422 START_DATE_TOO_EARLY server-side,
    // so the form says so without the round-trip...
    const creating = recurringTemplateFormSchema({ minStartDate: '2026-08-22' });
    const past = creating.safeParse({ ...input, start_date: '2026-08-21' });
    expect(past.success).toBe(false);
    expect(past.error?.issues.map((issue) => issue.path)).toContainEqual(['start_date']);
    // ...while today itself is legal (the server accepts `== today`).
    expect(creating.safeParse({ ...input, start_date: '2026-08-22' }).success).toBe(true);

    // EDIT supplies no minimum: the real floor is min(watermark, today) and the
    // watermark is server-only state, so the same past date must pass the client.
    expect(schema.safeParse({ ...input, start_date: '2026-08-21' }).success).toBe(true);
  });

  it('maps an empty end_date to null and keeps a well-formed one', () => {
    expect(schema.safeParse(input).data?.end_date).toBeNull();
    expect(schema.safeParse({ ...input, end_date: '2026-12-31' }).data?.end_date).toBe(
      '2026-12-31',
    );
    expect(schema.safeParse({ ...input, end_date: '31/12/2026' }).success).toBe(false);
  });

  it('keeps the "" sentinel on the optional string fields (bridged downstream)', () => {
    const parsed = schema.safeParse({ ...input, category_id: '', merchant: '', note: '' });
    expect(parsed.data?.category_id).toBe('');
    expect(parsed.data?.merchant).toBe('');
    expect(parsed.data?.note).toBe('');
  });
});

describe('categoryLimitFormSchema (5.4 W4)', () => {
  it('rejects "0" but accepts "1" — the server ge=1 floor, proven by contrast', () => {
    const schema = categoryLimitFormSchema('RUB');
    const zero = schema.safeParse({ amount: '0' });
    expect(zero.success).toBe(false);
    expect(zero.error?.issues[0]?.path).toEqual(['amount']);
    // Same currency, one minor unit apart in intent: "1" is a real budget.
    expect(schema.safeParse({ amount: '1' }).data?.amount).toBe(100);
  });

  it('parses sub-unit amounts at the given currency exponent', () => {
    expect(categoryLimitFormSchema('RUB').safeParse({ amount: '0.50' }).data?.amount).toBe(50);
    // The 100x contrast: the SAME string is a different amount in an exponent-0
    // currency, which is the whole point of binding the currency at construction.
    expect(categoryLimitFormSchema('JPY').safeParse({ amount: '50' }).data?.amount).toBe(50);
    expect(categoryLimitFormSchema('RUB').safeParse({ amount: '50' }).data?.amount).toBe(5000);
  });

  it('rejects a blank amount and an over-exponent one with the reason code', () => {
    const schema = categoryLimitFormSchema('RUB');
    const blank = schema.safeParse({ amount: '   ' });
    expect(blank.success).toBe(false);
    const blankIssue = blank.error?.issues[0];
    expect((blankIssue as { params?: { reason?: string } } | undefined)?.params?.reason).toBe(
      'empty',
    );

    const tooPrecise = schema.safeParse({ amount: '1.005' });
    expect(tooPrecise.success).toBe(false);
    const tooPreciseIssue = tooPrecise.error?.issues[0];
    expect(
      (tooPreciseIssue as { params?: { reason?: string } } | undefined)?.params?.reason,
    ).toBe('too-many-decimals');

    // A single decimal comma is a decimal point app-wide (parseMoney's
    // decimalCommaToPoint): "0,50" is what a Russian user types. Two separators stay
    // ambiguous between locales and are refused as malformed, never guessed.
    expect(schema.safeParse({ amount: '0,50' }).success).toBe(true);
    const ambiguousIssue = schema.safeParse({ amount: '1.234,56' }).error?.issues[0];
    expect(
      (ambiguousIssue as { params?: { reason?: string } } | undefined)?.params?.reason,
    ).toBe('malformed');
  });
});

describe('accountFormSchema signed starting balance (accounts W1)', () => {
  // The one signed money field in the app, and the only place a prefill string
  // may carry a '-'. This asserts the PAIR: `toSignedInputString` is the exact
  // inverse of the schema's sign peeling, so opening the edit form for a card in
  // the red and saving it unchanged cannot alter (or crash on) the stored value.
  // Routing that prefill through the unsigned `toInputString` threw a RangeError
  // and killed the modal — hence the round-trip rather than a one-way assertion.
  const base = { name: 'Card', type: 'card' as const };

  it.each([
    [-25_000, 'USD'],
    [-100, 'JPY'],
    [25_000, 'USD'],
    [0, 'USD'],
  ])('minor %i / %s survives prefill -> parse unchanged', (minor, currency) => {
    const parsed = accountFormSchema.safeParse({
      ...base,
      currency,
      starting_balance: toSignedInputString(minor, currency),
    });
    expect(parsed.data?.starting_balance_minor).toBe(minor);
  });
});
