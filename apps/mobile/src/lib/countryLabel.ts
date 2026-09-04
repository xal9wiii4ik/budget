// The country picker's labels — the Hermes `Intl.DisplayNames` seam.
//
// Web builds its country options with `Intl.DisplayNames` and nothing else,
// because every browser ships region names in every locale. Hermes does not ship
// the whole of Intl: it has `NumberFormat` and `Collator`, but NOT `PluralRules`
// (mobile-catchup-1 D-1 red-screened two tabs on that), so `DisplayNames` cannot
// be assumed either — and constructing a missing Intl constructor throws rather
// than degrading.
//
// So this module BRANCHES at runtime, once per call, and both arms are honest:
//
//   Intl.DisplayNames present -> the country's name in the UI language, exactly
//     what web shows.
//   absent -> the FLAG plus the code ("🇬🇪 GE"). Computed from the two letters
//     themselves (each ASCII letter -> its regional-indicator symbol), so it
//     needs no table, no Intl and no translation, and it is recognisable in any
//     language. A bare code would also be honest but much harder to scan.
//
// Which arm is live on a real device is logged by `runDevProbes` (lib/probes.ts).
import { COUNTRY_CODE_PATTERN, COUNTRY_CODES } from '@budget/shared';

// 'A'.charCodeAt(0) -> U+1F1E6 REGIONAL INDICATOR SYMBOL LETTER A.
const REGIONAL_INDICATOR_A = 0x1f1e6;
const ASCII_A = 'A'.charCodeAt(0);

/** "GE" -> "🇬🇪". Pure string math — no Intl, no lookup table. */
export function flagEmoji(code: string): string {
  return [...code.toUpperCase()]
    .map((letter) => String.fromCodePoint(REGIONAL_INDICATOR_A + letter.charCodeAt(0) - ASCII_A))
    .join('');
}

/** Is `Intl.DisplayNames` usable on this runtime? Read at call time, not import. */
function hasDisplayNames(): boolean {
  return typeof Intl !== 'undefined' && typeof Intl.DisplayNames === 'function';
}

/**
 * One country's label in `locale`. A malformed code is returned as-is: it is
 * never handed to `Intl.DisplayNames`, which throws a RangeError on anything that
 * is not a well-formed region code.
 */
export function countryLabel(locale: string, code: string): string {
  if (!COUNTRY_CODE_PATTERN.test(code)) return code;
  if (hasDisplayNames()) {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code;
  }
  return `${flagEmoji(code)} ${code}`;
}

export interface CountryOption {
  code: string;
  label: string;
}

/**
 * The picker's options: CODES from the shared table, LABELS from `countryLabel`.
 *
 * `include` is a code that must appear even when the shared table does not carry
 * it — a value another client stamped on a row (the table deliberately omits the
 * uninhabited territories, and the server validates the FORMAT only). Dropping it
 * would leave the picker showing "Not set" while the form state held a country.
 *
 * Sorted with `Intl.Collator` (which Hermes DOES have — probe W11) in the UI
 * locale, because alphabetical order is language-specific too. In the fallback
 * arm the labels start with a flag and sort by their code, which is the same
 * order for every language — acceptable, and visible at a glance.
 */
export function countryOptions(locale: string, include?: string | null): CountryOption[] {
  const extra =
    include && COUNTRY_CODE_PATTERN.test(include) && !COUNTRY_CODES.includes(include)
      ? [include]
      : [];
  const collator = new Intl.Collator(locale);
  return [...COUNTRY_CODES, ...extra]
    .map((code) => ({ code, label: countryLabel(locale, code) }))
    .sort((a, b) => collator.compare(a.label, b.label));
}
