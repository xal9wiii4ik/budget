// Periodicity labels (WR-4, obligation R1).
//
// THE WEEKDAY CONVENTION IS ISO 0 = MONDAY (architecture D3, Python's
// `date.weekday()`). JavaScript's `Date.getDay()` is 0 = SUNDAY, and six of the
// seven values look plausible under either reading — which is why `getDay()`
// appears NOWHERE in this scope and every label comes from here.
//
// The labels are produced by formatting a KNOWN REFERENCE WEEK: 2024-01-01 was a
// Monday, so index i of the array is the i-th day after that Monday. No weekday
// is ever read off a Date; the wire value is only ever used as an INDEX into this
// array, so a shift in either convention is a visible, testable label change
// rather than a silent off-by-one.
import type { RecurringTemplateRead } from '../../data/recurring';
import type { Translate } from '../../i18n/t';

// Local midnight (TZ-safe, the shared dates.ts discipline) of a Monday.
const REFERENCE_MONDAY = { year: 2024, monthIndex: 0, day: 1 } as const;

const weekdayFormatterCache = new Map<string, Intl.DateTimeFormat>();

function weekdayFormatter(locale: string | undefined): Intl.DateTimeFormat {
  const key = locale ?? '';
  let formatter = weekdayFormatterCache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { weekday: 'long' });
    weekdayFormatterCache.set(key, formatter);
  }
  return formatter;
}

/** Seven localized weekday names, index 0 = Monday .. 6 = Sunday (the WIRE order). */
export function weekdayLabels(locale?: string): string[] {
  const formatter = weekdayFormatter(locale);
  return Array.from({ length: 7 }, (_, index) =>
    formatter.format(
      new Date(REFERENCE_MONDAY.year, REFERENCE_MONDAY.monthIndex, REFERENCE_MONDAY.day + index),
    ),
  );
}

/**
 * "Monthly on day 5" / "Weekly on Monday".
 *
 * The bare "Monthly"/"Weekly" arms are unreachable through the API (the DB CHECK
 * `anchor_matches_unit` keeps the unit's anchor non-null): they exist so a
 * contract violation degrades to a true-but-vaguer sentence instead of rendering
 * "day null".
 */
export function periodicityLabel(
  template: RecurringTemplateRead,
  t: Translate,
  locale?: string,
): string {
  if (template.interval_unit === 'month') {
    return template.day_of_month === null
      ? t('periodicity.monthly')
      : t('periodicity.monthlyOnDay', { day: template.day_of_month });
  }
  // The weekday NAME comes from Intl in the chosen locale; only the sentence
  // around it is a dictionary entry.
  const label = template.weekday === null ? undefined : weekdayLabels(locale)[template.weekday];
  return label === undefined
    ? t('periodicity.weekly')
    : t('periodicity.weeklyOn', { weekday: label });
}
