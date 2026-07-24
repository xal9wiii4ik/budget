// Money helpers. Amounts are integer MINOR units end-to-end (e.g. cents).
//
// Determinism contract (plan D2): the hardcoded CURRENCY_EXPONENTS table is the
// sole source of truth for minor<->major conversion. Intl is used ONLY to render
// display strings, and even there we pin the fraction digits to our table's
// exponent rather than trusting Intl's per-currency default — Hermes and V8 ship
// different CLDR/ICU vintages, so an Intl-derived exponent could disagree across
// runtimes and leak into stored values.
//
// Locale note (plan AM2): `options.locale` is intentionally optional. In app code
// it defaults to the host default; every test pins 'en-US'. The 1.8 mobile client
// will pass an explicit locale sourced from expo-localization rather than relying
// on Hermes' host-default, which is less reliable on some Android OEM configs.
import {
  CURRENCY_CODE_PATTERN,
  CURRENCY_EXPONENTS,
  DEFAULT_CURRENCY_EXPONENT,
} from './currencies';

export type MoneyParseError =
  | 'empty' // blank / whitespace-only
  | 'malformed' // not a bare non-negative decimal
  | 'negative' // leading '-' — the amount field carries magnitudes only
  | 'too-many-decimals' // more fraction digits than the currency exponent
  | 'overflow'; // result is not a safe integer

export type ParseMoneyResult =
  | { ok: true; minor: number }
  | { ok: false; error: MoneyParseError };

// Reads the hardcoded exponent table; unknown well-formed codes default to 2.
// Never throws — a well-formed but unlisted code (e.g. an OCR result) must not
// crash the client. (plan D3)
export function getCurrencyExponent(currency: string): number {
  return CURRENCY_EXPONENTS[currency] ?? DEFAULT_CURRENCY_EXPONENT;
}

// Accepts "123", "12.50", ".5", "12." — a bare non-negative decimal with '.'
// as the ONLY separator. Bare "." is malformed. (plan D1 + AM3)
const MONEY_INPUT_PATTERN = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

// "12.50" + 'USD' -> { ok: true, minor: 1250 }. No float arithmetic: the minor
// value is built by digit-string concatenation and a single Number(). (plan D1)
export function parseMoney(input: string, currency: string): ParseMoneyResult {
  const s = input.trim();
  if (s === '') return { ok: false, error: 'empty' };
  if (s.startsWith('-')) return { ok: false, error: 'negative' };
  if (!MONEY_INPUT_PATTERN.test(s)) return { ok: false, error: 'malformed' };

  const exp = getCurrencyExponent(currency);
  const [intPart, fracPart = ''] = s.split('.');
  if (fracPart.length > exp) return { ok: false, error: 'too-many-decimals' };

  // Pad the fraction to the exponent, then concatenate. `intPart` is '' only for
  // the ".5" form, where `fracPart` has >= 1 digit, so `digits` is never empty
  // (AM5: no dead empty-string branch). Number() ignores leading zeros, so
  // "007.50" -> "00750" -> 750 with no explicit leading-zero strip.
  const frac = fracPart.padEnd(exp, '0');
  const digits = intPart + frac;
  const minor = Number(digits);
  if (!Number.isSafeInteger(minor)) return { ok: false, error: 'overflow' };
  return { ok: true, minor };
}

// --- Intl formatter cache (plan AM1) -------------------------------------
// Per-call Intl.NumberFormat construction crosses into OS ICU/Foundation on
// Hermes and is materially expensive on Android mid-tier devices (invisible to
// the Node test gate). Memoize instances behind the unchanged signatures.
const numberFormatterCache = new Map<string, Intl.NumberFormat>();

function currencyFormatter(
  locale: string | undefined,
  currency: string,
  exp: number,
): Intl.NumberFormat {
  const key = `${locale ?? ''}|${currency}|${exp}`;
  let f = numberFormatterCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      currencyDisplay: 'symbol',
      minimumFractionDigits: exp,
      maximumFractionDigits: exp,
    });
    numberFormatterCache.set(key, f);
  }
  return f;
}

function decimalFormatter(locale: string | undefined, exp: number): Intl.NumberFormat {
  const key = `${locale ?? ''}|decimal|${exp}`;
  let f = numberFormatterCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, {
      style: 'decimal',
      minimumFractionDigits: exp,
      maximumFractionDigits: exp,
      useGrouping: true,
    });
    numberFormatterCache.set(key, f);
  }
  return f;
}

// The single controlled float boundary (plan D5): a safe-integer minor divided by
// 10**exp is handed to Intl, which immediately rounds to exactly `exp` fraction
// digits. All value-affecting arithmetic (parse, round-trip) stays integer/string.
function assertSafeMinor(minor: number): void {
  if (!Number.isSafeInteger(minor)) {
    throw new RangeError(`minor units out of safe-integer range: ${minor}`);
  }
}

// toInputString takes a non-negative magnitude (parseMoney's exact inverse), so
// it rejects negatives too — unlike formatMoney, where a negative net is a
// legitimate display value. Without this guard String(-5)/fractional inputs would
// produce garbage ("0.-5", "12.5" -> bad slices) and leak into edit-form prefill.
function assertNonNegativeMinor(minor: number): void {
  if (!Number.isSafeInteger(minor) || minor < 0) {
    throw new RangeError(`minor units must be a non-negative safe integer: ${minor}`);
  }
}

function assertWellFormedCurrency(currency: string): void {
  if (!CURRENCY_CODE_PATTERN.test(currency)) {
    throw new RangeError(`malformed currency code: ${currency}`);
  }
}

// 1250 + 'USD' + en-US -> "$12.50". Locale-aware, symbol shown.
export function formatMoney(
  minor: number,
  currency: string,
  options?: { locale?: string },
): string {
  assertSafeMinor(minor);
  assertWellFormedCurrency(currency);
  const exp = getCurrencyExponent(currency);
  return currencyFormatter(options?.locale, currency, exp).format(minor / 10 ** exp);
}

// 1250 + 'USD' + en-US -> "12.50" (no symbol, locale grouping). For chart axes
// and cells where the currency symbol is rendered separately.
export function formatAmount(
  minor: number,
  currency: string,
  options?: { locale?: string },
): string {
  assertSafeMinor(minor);
  assertWellFormedCurrency(currency);
  const exp = getCurrencyExponent(currency);
  return decimalFormatter(options?.locale, exp).format(minor / 10 ** exp);
}

// 1250 + 'USD' -> "12.50" — machine string: no grouping, '.' separator, fraction
// digits pinned to the exponent. Fully float-free; the exact inverse of
// parseMoney, for edit-form prefill. `minor` is a non-negative magnitude.
export function toInputString(minor: number, currency: string): string {
  assertNonNegativeMinor(minor);
  const exp = getCurrencyExponent(currency);
  if (exp === 0) return String(minor);
  const padded = String(minor).padStart(exp + 1, '0');
  const intPart = padded.slice(0, -exp);
  const fracPart = padded.slice(-exp);
  return `${intPart}.${fracPart}`;
}
