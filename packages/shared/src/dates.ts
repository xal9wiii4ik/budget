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
