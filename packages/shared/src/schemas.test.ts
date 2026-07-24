import { describe, it, expect } from 'vitest';
import { categoryFormSchema, currencyCodeSchema, moneyAmountSchema } from './schemas';

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
