import { describe, it, expect } from 'vitest';
import {
  categoryFormSchema,
  contributionFormSchema,
  currencyCodeSchema,
  goalFormSchema,
  moneyAmountSchema,
  multiCurrencyTransactionFormSchema,
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
