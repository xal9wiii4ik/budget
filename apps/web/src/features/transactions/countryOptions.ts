import { COUNTRY_CODE_PATTERN, COUNTRY_CODES } from '@budget/shared';

export interface CountryOption {
  code: string;
  /** The country's name in the UI language, from `Intl.DisplayNames`. */
  label: string;
}

/**
 * The country picker's options: CODES from the shared table (@budget/shared),
 * LABELS from the runtime. Intl already ships country names in every locale this
 * app runs in, so nothing here is hand-translated and the list follows the
 * language switch for free — and it is collated in that same locale, because
 * alphabetical order is language-specific too.
 *
 * Extracted from TransactionFormModal (search-and-drilldown S3) because the
 * /transactions filter popover needs exactly the same list: two copies of this
 * would drift the day the table or the sort rule changes.
 *
 * `include` is a code that must appear even when the shared table does not carry
 * it — a country filter arriving from the URL, or a value another client stamped
 * on a row (the table deliberately omits the uninhabited territories, and the
 * server validates the FORMAT only). A <select> whose value matches no option
 * silently displays the first one, i.e. lies about what the list is filtered by.
 * A malformed `include` is ignored rather than passed to `Intl.DisplayNames`,
 * which throws a RangeError on anything that is not a well-formed region code.
 */
export function countryOptions(locale: string, include?: string | null): CountryOption[] {
  const names = new Intl.DisplayNames([locale], { type: 'region' });
  const extra =
    include && COUNTRY_CODE_PATTERN.test(include) && !COUNTRY_CODES.includes(include)
      ? [include]
      : [];
  return [...COUNTRY_CODES, ...extra]
    .map((code) => ({ code, label: names.of(code) ?? code }))
    .sort((a, b) => a.label.localeCompare(b.label, locale));
}

/**
 * One country's name in the UI language — for the active-filter chip, which
 * needs a label without building (and sorting) the whole picker list. Falls back
 * to the code itself: a chip that says "BY" is honest, a blank one is not.
 */
export function countryLabel(locale: string, code: string): string {
  if (!COUNTRY_CODE_PATTERN.test(code)) return code;
  return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code;
}
