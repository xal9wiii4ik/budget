import { describe, it, expect } from 'vitest';
import {
  getCurrencyExponent,
  parseMoney,
  toInputString,
  formatMoney,
  formatAmount,
} from './money';

describe('getCurrencyExponent', () => {
  it('reads the table for non-2 exponents and defaults 2 for the rest', () => {
    expect(getCurrencyExponent('JPY')).toBe(0);
    expect(getCurrencyExponent('KWD')).toBe(3);
    expect(getCurrencyExponent('USD')).toBe(2);
    expect(getCurrencyExponent('ZZZ')).toBe(2); // unknown -> default
  });
});

describe('parseMoney — accept', () => {
  it('parses standard and short-fraction amounts', () => {
    expect(parseMoney('12.50', 'USD')).toEqual({ ok: true, minor: 1250 });
    expect(parseMoney('12.5', 'USD')).toEqual({ ok: true, minor: 1250 }); // pad
  });

  it('honours the currency exponent', () => {
    expect(parseMoney('100', 'JPY')).toEqual({ ok: true, minor: 100 }); // exp 0
    expect(parseMoney('1.234', 'KWD')).toEqual({ ok: true, minor: 1234 }); // exp 3
  });

  it('handles zero, whitespace and leading zeros', () => {
    expect(parseMoney('0', 'USD')).toEqual({ ok: true, minor: 0 });
    expect(parseMoney('  12.50  ', 'USD')).toEqual({ ok: true, minor: 1250 }); // trim
    expect(parseMoney('007.50', 'USD')).toEqual({ ok: true, minor: 750 }); // leading zeros
  });

  it('accepts the ".5" and "12." typing forms (AM3)', () => {
    expect(parseMoney('.5', 'USD')).toEqual({ ok: true, minor: 50 });
    expect(parseMoney('12.', 'USD')).toEqual({ ok: true, minor: 1200 });
  });
});

describe('parseMoney — reject with distinct error codes', () => {
  it('empty / whitespace-only', () => {
    expect(parseMoney('', 'USD')).toEqual({ ok: false, error: 'empty' });
    expect(parseMoney('   ', 'USD')).toEqual({ ok: false, error: 'empty' });
  });

  it('malformed shapes, including bare "." (AM3)', () => {
    expect(parseMoney('abc', 'USD')).toEqual({ ok: false, error: 'malformed' });
    expect(parseMoney('1.2.3', 'USD')).toEqual({ ok: false, error: 'malformed' });
    expect(parseMoney('.', 'USD')).toEqual({ ok: false, error: 'malformed' });
  });

  it('negative magnitudes', () => {
    expect(parseMoney('-5', 'USD')).toEqual({ ok: false, error: 'negative' });
  });

  it('too many decimals for the currency exponent', () => {
    expect(parseMoney('12.505', 'USD')).toEqual({ ok: false, error: 'too-many-decimals' });
    expect(parseMoney('1.5', 'JPY')).toEqual({ ok: false, error: 'too-many-decimals' });
  });

  it('overflow past MAX_SAFE_INTEGER', () => {
    expect(parseMoney('99999999999999999', 'USD')).toEqual({ ok: false, error: 'overflow' });
  });
});

describe('parseMoney <-> toInputString round-trip', () => {
  const cases: Array<[number, string]> = [
    [1250, 'USD'],
    [100, 'JPY'],
    [1234, 'KWD'],
    [0, 'USD'],
  ];
  it.each(cases)('minor %i / %s survives the round-trip', (minor, currency) => {
    expect(parseMoney(toInputString(minor, currency), currency)).toEqual({ ok: true, minor });
  });
});

describe('toInputString', () => {
  it('formats per exponent, float-free', () => {
    expect(toInputString(1250, 'USD')).toBe('12.50');
    expect(toInputString(5, 'USD')).toBe('0.05');
    expect(toInputString(100, 'JPY')).toBe('100'); // exp 0 -> no dot
    expect(toInputString(1234, 'KWD')).toBe('1.234'); // exp 3 -> padded
  });

  it('throws on negative or fractional minor (non-negative magnitude only)', () => {
    expect(() => toInputString(-5, 'USD')).toThrow(RangeError);
    expect(() => toInputString(12.5, 'USD')).toThrow(RangeError);
  });
});

describe('formatMoney / formatAmount (locale en-US pinned)', () => {
  it('renders the currency symbol with pinned fraction digits', () => {
    expect(formatMoney(1250, 'USD', { locale: 'en-US' })).toBe('$12.50');
    expect(formatMoney(100, 'JPY', { locale: 'en-US' })).toBe('¥100'); // 0 digits
    // KWD separates symbol/amount with an NBSP whose exact char is ICU-version
    // dependent; assert the 3-fraction pinning (contrast USD's 2) robustly.
    expect(formatMoney(1234, 'KWD', { locale: 'en-US' })).toContain('1.234'); // 3 digits
  });

  it('formatAmount omits the symbol', () => {
    expect(formatAmount(1250, 'USD', { locale: 'en-US' })).toBe('12.50');
  });

  it('throws on out-of-safe-range minor', () => {
    expect(() => formatMoney(Number.MAX_SAFE_INTEGER + 1, 'USD', { locale: 'en-US' })).toThrow(
      RangeError,
    );
  });
});
