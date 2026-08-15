// Date helpers for the API wire format ("YYYY-MM-DD", the `occurred_at` shape).
//
// TZ-safety (plan D7): we NEVER construct a Date from the raw ISO date string
// (`new Date('2026-07-24')` parses as UTC midnight and shifts a day back in
// negative-offset zones). Instead we split the components and build a LOCAL Date,
// and only format a date-only style — so no timezone conversion is ever exercised.
//
// Locale note (plan AM2): `options.locale` is optional and defaults to the host
// default; tests pin 'en-US'. The 1.8 mobile client passes an explicit locale
// from expo-localization.

// --- Intl formatter cache (plan AM1) -------------------------------------
// Memoize DateTimeFormat instances keyed by locale|dateStyle; per-call Intl
// construction is expensive on Hermes/Android and invisible to the Node gate.
const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();

function mediumDateFormatter(locale: string | undefined): Intl.DateTimeFormat {
  const key = `${locale ?? ''}|medium`;
  let f = dateFormatterCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
    dateFormatterCache.set(key, f);
  }
  return f;
}

// "2026-07-24" -> "Jul 24, 2026" (en-US) with NO timezone shift.
export function formatApiDate(isoDate: string, options?: { locale?: string }): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const local = new Date(y, m - 1, d); // local midnight — no UTC parse
  return mediumDateFormatter(options?.locale).format(local);
}

// local Date -> "YYYY-MM-DD" (zero-padded) for API params / form values.
export function toApiDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// today in the user's LOCAL date as "YYYY-MM-DD".
export function todayApiDate(): string {
  return toApiDate(new Date());
}

// --- Month helpers (plan R5/T10) -----------------------------------------
// The transactions screen is month-scoped: the URL carries "YYYY-MM", the list
// filter derives day bounds from it, and the picker shifts it. All month math is
// LOCAL `Date(y, m-1, ...)` component arithmetic — never an ISO-string parse — so
// it is TZ-safe like `formatApiDate`, and `Date` normalises rollover/leap natively.

// (2026, 7) -> "2026-07". `month` is 1-based; both parts zero-padded.
export function monthParam(year: number, month: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

// today's LOCAL month as "YYYY-MM".
export function currentMonth(): string {
  const now = new Date();
  return monthParam(now.getFullYear(), now.getMonth() + 1);
}

// ("2026-01", -1) -> "2025-12"; ("2025-12", 1) -> "2026-01". Delta in months; the
// Date constructor carries the year across the Dec/Jan boundary for us.
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const shifted = new Date(y, m - 1 + delta, 1);
  return monthParam(shifted.getFullYear(), shifted.getMonth() + 1);
}

// "2026-02" -> { from: "2026-02-01", to: "2026-02-28" }. Last day via
// `new Date(y, m, 0).getDate()` — day 0 of the NEXT month is the last day of this
// one, and Date resolves leap Feb (2024 -> 29, 2025 -> 28) with no special-casing.
export function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  return {
    from: `${month}-01`,
    to: `${month}-${String(lastDay).padStart(2, '0')}`,
  };
}

// --- Month-label formatter cache (mirrors the medium-date cache above) ----
const monthFormatterCache = new Map<string, Intl.DateTimeFormat>();

function monthLabelFormatter(locale: string | undefined): Intl.DateTimeFormat {
  const key = `${locale ?? ''}|monthLabel`;
  let f = monthFormatterCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long' });
    monthFormatterCache.set(key, f);
  }
  return f;
}

function shortMonthLabelFormatter(locale: string | undefined): Intl.DateTimeFormat {
  const key = `${locale ?? ''}|monthLabelShort`;
  let f = monthFormatterCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { year: '2-digit', month: 'short' });
    monthFormatterCache.set(key, f);
  }
  return f;
}

// "2026-07" -> "July 2026" (en-US), no timezone shift (local midnight of day 1).
export function formatMonthLabel(month: string, options?: { locale?: string }): string {
  const [y, m] = month.split('-').map(Number);
  const local = new Date(y, m - 1, 1);
  return monthLabelFormatter(options?.locale).format(local);
}

// "2026-07" -> "Jul 26" (en-US). The compact form for chart axis ticks, where a
// dozen "July 2026"-width labels do not fit. Same TZ-safe local construction.
export function formatMonthShortLabel(month: string, options?: { locale?: string }): string {
  const [y, m] = month.split('-').map(Number);
  const local = new Date(y, m - 1, 1);
  return shortMonthLabelFormatter(options?.locale).format(local);
}
