import { describe, it, expect } from 'vitest';
import { currencyCodeSchema, moneyAmountSchema } from './schemas';

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

describe('currencyCodeSchema', () => {
  it('accepts a well-formed code and rejects malformed shapes', () => {
    expect(currencyCodeSchema.parse('USD')).toBe('USD');
    expect(currencyCodeSchema.safeParse('usd').success).toBe(false);
    expect(currencyCodeSchema.safeParse('US').success).toBe(false);
    expect(currencyCodeSchema.safeParse('DOLLAR').success).toBe(false);
  });
});
