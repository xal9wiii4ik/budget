// The ONE period ↔ URL ↔ wire mapping for /stats (WS-1). PURE: no React, no
// hooks, no DOM beyond the URLSearchParams value it is handed — everything here
// is total functions over strings, which is what makes it testable and what keeps
// the picker component free of grammar logic.
//
// Two hard rules it exists to enforce:
//
//  1. `parsePeriodParams` is TOTAL. A missing, unknown or malformed `period`, or
//     a chosen unit whose anchor is absent/unparseable, falls back to the current
//     month. The client therefore never sends a request the server would answer
//     422 PERIOD_ANCHOR_REQUIRED — that code is a bug signal in the web (WS-6),
//     never a user-facing error, exactly as the *_REQUIRED family is treated at
//     1.6/3.2.
//  2. `periodQuery` emits `period` ALWAYS plus exactly the ONE anchor that unit
//     needs. The server ignores redundant anchors, but emitting a stray `month=`
//     alongside `period=year` would make the query key lie about what was asked.
//
// The client NEVER computes a period's bounds: `from`/`to` for month/quarter/year
// are the server's to resolve and echo back (D16). The only date math here is
// picker NAVIGATION (shiftPeriod) and labels.
import {
  currentMonth,
  formatApiDate,
  formatMonthLabel,
  formatQuarterLabel,
  quarterOfMonth,
  shiftMonth,
  shiftQuarter,
} from '@budget/shared';

import type { StatsPeriodQuery } from '../../data/queryKeys';

/** What the picker holds and the URL carries. `custom` bounds are INCLUSIVE. */
export type PeriodSelection =
  | { unit: 'month'; month: string } // "YYYY-MM"
  | { unit: 'quarter'; quarter: string } // "YYYY-Q1".."YYYY-Q4"
  | { unit: 'year'; year: number }
  | { unit: 'custom'; from: string; to: string }; // "YYYY-MM-DD"

export type PeriodUnit = PeriodSelection['unit'];

export const PERIOD_UNITS: readonly PeriodUnit[] = ['month', 'quarter', 'year', 'custom'];

// Mirrors the server's year envelope (domain/periods.py MIN_YEAR/MAX_YEAR). Not
// a duplicated business rule — it is the range in which the server's own date
// math cannot overflow, and honouring it here is what turns a hand-typed
// `?period=year&year=99999` into a silent fallback instead of a raw 422 panel.
const MIN_PERIOD_YEAR = 1970;
const MAX_PERIOD_YEAR = 2999;

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const QUARTER_PATTERN = /^\d{4}-Q[1-4]$/;
const YEAR_PATTERN = /^\d{4}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function yearInEnvelope(year: number): boolean {
  return Number.isInteger(year) && year >= MIN_PERIOD_YEAR && year <= MAX_PERIOD_YEAR;
}

function isValidMonth(value: string): boolean {
  return MONTH_PATTERN.test(value) && yearInEnvelope(Number(value.slice(0, 4)));
}

function isValidQuarter(value: string): boolean {
  return QUARTER_PATTERN.test(value) && yearInEnvelope(Number(value.slice(0, 4)));
}

/**
 * A real calendar date inside the server envelope. The round-trip check rejects
 * "2026-02-31" (which `new Date` silently rolls to March 3) — a date input can
 * only produce real dates, but a hand-typed URL cannot be trusted.
 */
function isValidApiDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (!yearInEnvelope(y)) return false;
  const local = new Date(y, m - 1, d); // local midnight — never an ISO parse (D7)
  return (
    local.getFullYear() === y && local.getMonth() === m - 1 && local.getDate() === d
  );
}

/** The fallback every malformed input lands on, and the "reset" action's target. */
export function defaultPeriod(): PeriodSelection {
  return { unit: 'month', month: currentMonth() };
}

/**
 * URL search params -> selection. TOTAL by construction: every branch that does
 * not produce a fully valid selection returns `defaultPeriod()`.
 */
export function parsePeriodParams(params: URLSearchParams): PeriodSelection {
  switch (params.get('period')) {
    case 'month': {
      const month = params.get('month');
      return month && isValidMonth(month) ? { unit: 'month', month } : defaultPeriod();
    }
    case 'quarter': {
      const quarter = params.get('quarter');
      return quarter && isValidQuarter(quarter)
        ? { unit: 'quarter', quarter }
        : defaultPeriod();
    }
    case 'year': {
      const year = params.get('year');
      return year && YEAR_PATTERN.test(year) && yearInEnvelope(Number(year))
        ? { unit: 'year', year: Number(year) }
        : defaultPeriod();
    }
    case 'custom': {
      const from = params.get('from');
      const to = params.get('to');
      // `from > to` is deliberately NOT rejected: the server resolves it to an
      // empty window and answers zeros (read filters never error), and the empty
      // state says so. Rejecting it here would be a second source of truth.
      return from && to && isValidApiDate(from) && isValidApiDate(to)
        ? { unit: 'custom', from, to }
        : defaultPeriod();
    }
    default:
      return defaultPeriod();
  }
}

/**
 * Every key this module owns in the URL. The page CLEARS all of them before
 * writing the new selection, so switching unit cannot leave a stale
 * `month=`/`from=` behind — the request would still be correct (periodQuery emits
 * only the chosen anchor), but the URL would lie about what is on screen and a
 * shared link would carry junk.
 */
export const PERIOD_PARAM_KEYS = [
  'period',
  'month',
  'quarter',
  'year',
  'from',
  'to',
] as const;

/** Selection -> the URL params the picker writes. Exactly one anchor. */
export function periodSearchParams(selection: PeriodSelection): Record<string, string> {
  switch (selection.unit) {
    case 'month':
      return { period: 'month', month: selection.month };
    case 'quarter':
      return { period: 'quarter', quarter: selection.quarter };
    case 'year':
      return { period: 'year', year: String(selection.year) };
    case 'custom':
      return { period: 'custom', from: selection.from, to: selection.to };
  }
}

/** Selection -> the WIRE query object (also the query key member — WS-2). */
export function periodQuery(selection: PeriodSelection): StatsPeriodQuery {
  switch (selection.unit) {
    case 'month':
      return { period: 'month', month: selection.month };
    case 'quarter':
      return { period: 'quarter', quarter: selection.quarter };
    case 'year':
      return { period: 'year', year: selection.year };
    case 'custom':
      return { period: 'custom', from: selection.from, to: selection.to };
  }
}

/**
 * The prev/next stepper. IDENTITY for `custom`: "the same length immediately
 * before" is a server concept for the comparison block, not a navigation gesture
 * the user asked for — the stepper is not rendered for custom at all.
 */
export function shiftPeriod(selection: PeriodSelection, delta: -1 | 1): PeriodSelection {
  switch (selection.unit) {
    case 'month':
      return { unit: 'month', month: shiftMonth(selection.month, delta) };
    case 'quarter':
      return { unit: 'quarter', quarter: shiftQuarter(selection.quarter, delta) };
    case 'year':
      return { unit: 'year', year: selection.year + delta };
    case 'custom':
      return selection;
  }
}

/**
 * The month a selection "sits in" — the anchor a unit switch carries over. Pure
 * label arithmetic on the selection the user already made; it is NOT a period
 * bound (those are resolved and echoed by the server — D16).
 */
function anchorMonthOf(selection: PeriodSelection): string {
  switch (selection.unit) {
    case 'month':
      return selection.month;
    case 'quarter': {
      const year = selection.quarter.slice(0, 4);
      const firstMonth = (Number(selection.quarter.slice(-1)) - 1) * 3 + 1;
      return `${year}-${String(firstMonth).padStart(2, '0')}`;
    }
    case 'year':
      return `${selection.year}-01`;
    case 'custom':
      return selection.from.slice(0, 7);
  }
}

/**
 * Switching the unit tab keeps the user roughly where they were instead of
 * jumping to today — looking at Q2 2024 and clicking "Year" gives 2024, not the
 * current year.
 */
export function withUnit(selection: PeriodSelection, unit: PeriodUnit): PeriodSelection {
  if (selection.unit === unit) return selection;
  const anchorMonth = anchorMonthOf(selection);
  switch (unit) {
    case 'month':
      return { unit: 'month', month: anchorMonth };
    case 'quarter':
      return { unit: 'quarter', quarter: quarterOfMonth(anchorMonth) };
    case 'year':
      return { unit: 'year', year: Number(anchorMonth.slice(0, 4)) };
    case 'custom':
      // The anchor month's FIRST day for both ends — a starting point for the two
      // date inputs, deliberately not a guess at the month's last day (computing
      // a period's end client-side is exactly what D16 forbids). The user picks
      // the end; until they do, the window is one day and the screen says so.
      return { unit: 'custom', from: `${anchorMonth}-01`, to: `${anchorMonth}-01` };
  }
}

/**
 * Presentation only. The section header ALSO shows the server-echoed
 * `period.from`/`period.to` once the response lands — the resolved bounds are
 * the server's, this label is just what the user picked.
 */
export function periodLabel(selection: PeriodSelection, locale?: string): string {
  switch (selection.unit) {
    case 'month':
      return formatMonthLabel(selection.month, { locale });
    case 'quarter':
      return formatQuarterLabel(selection.quarter, { locale });
    case 'year':
      return String(selection.year);
    case 'custom':
      return `${formatApiDate(selection.from, { locale })} – ${formatApiDate(selection.to, { locale })}`;
  }
}

/** The unit tab's own label. */
export function unitLabel(unit: PeriodUnit): string {
  switch (unit) {
    case 'month':
      return 'Month';
    case 'quarter':
      return 'Quarter';
    case 'year':
      return 'Year';
    case 'custom':
      return 'Custom';
  }
}
