# @budget/shared

Framework-free utilities shared by the web and mobile clients: money parse/format,
ISO-4217 exponents, API date helpers, and zod primitives. Single `.` entry (the
barrel `src/index.ts`); consumed as source (no build step).

## Money

Amounts are **integer minor units** end-to-end (e.g. cents). The hardcoded
`CURRENCY_EXPONENTS` table is the sole source of truth for minor↔major conversion;
`Intl` is display-only with fraction digits pinned to that table, so cross-runtime
CLDR/ICU differences never leak into stored values. `parseMoney` accepts a bare
non-negative decimal with `.` as the only separator (`"12.50"`, `".5"`, `"12."`),
rejects negatives (the amount field carries magnitudes; sign lives on category
kind) and never silently rounds excess decimals.

## Locale / Hermes notes

- `options.locale` on the format helpers is **optional**. App code may rely on the
  host default; every test pins `'en-US'`. The **1.8 mobile** client is expected to
  pass an explicit locale sourced from `expo-localization` rather than rely on
  Hermes' host-default (less reliable on some Android OEM configs).
- The `{ locale: 'en-US' }`-pinned scaffold canary (`formatMoney(12345, 'USD', …)`
  → `"$123.45"`) proves only that **the Intl currency path executes on Hermes**,
  not device-locale correctness. A green canary is not locale-matrix proof; the
  classic `US$`/NBSP/symbol-placement divergences are not exercised by it.
- Formatter instances are memoized in a module-level cache (per-call
  `Intl.*Format` construction is a real JS-thread cost on Hermes/Android and is
  invisible to the Node test gate).

## Dates

Wire format is `"YYYY-MM-DD"` (the `occurred_at` shape). Helpers never construct a
`Date` from the raw ISO string (that parses as UTC and shifts a day in negative
offsets); they build a **local** `Date` from split components and format a
date-only style. The test suite pins `TZ=America/Los_Angeles` via the `test`
script to guard the shift.
