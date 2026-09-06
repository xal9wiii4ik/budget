// VERBATIM COPY of apps/web/src/features/recurring/firstCharge.ts (catch-up 3, line B):
// same rule, same wording of the decisions, and web's own vitest file already
// pins it — a second identical test on this side would only re-assert it.
// When does a template with THIS schedule and THIS start date actually fire?
//
// The form has two controls that both talk about a date — `start_date` and the
// anchor (`day_of_month` / `weekday`) — and the server resolves the pair with a
// rule the user cannot see: `start_date` is only a FLOOR (the create route stamps
// the watermark at `start_date - 1 day`), while the anchor decides the day. Pick
// "23 August" and leave the default "monthly on day 1" and the first charge lands
// on 1 September. This module computes that date so the form can SAY it.
//
// It mirrors `apps/api/src/budget_api/domain/recurrence.py`:
//   * `monthly_due()` clamps with `min(day_of_month, days_in_month)` —
//     day 31 in April is 30 April, never 1 May; the same clamp is reproduced here
//     with "day 0 of the next month" (`Date.UTC(y, m, 0)`).
//   * `next_due()` returns the first due date STRICTLY after `after`,
//     and the create route passes `after = start_date - 1 day`, so what we want
//     is the first due date ON OR AFTER `start_date`. That equivalence is the one
//     thing to re-check if the router ever stops seeding `start_date - 1`.
//   * the weekly arm's `(weekday - after.weekday()) % 7 or 7` collapses, for
//     `after = start - 1`, to `start + ((anchor - startWeekday) mod 7)` — the
//     first matching weekday on or after the start. `weekday` is ISO 0 = MONDAY
//     (D3, Python's `date.weekday()`), NOT JavaScript's 0 = Sunday.
//
// ADVISORY ONLY. Nothing here is sent to the server or stored: the server owns
// `next_due_on` and remains the only authority. This is a sentence in the form,
// which is why it is allowed to compute a date at all (R2 forbids re-deriving
// server state as if it were data).
//
// Pure: no clock, no DOM, no locale. Dates are "YYYY-MM-DD" strings in and out,
// and every intermediate `Date` is built through `Date.UTC` — a date-only string
// handed to `new Date()` parses as UTC midnight and then reads back a day early
// through the LOCAL getters in any negative-offset zone (the dates.ts discipline).
//
// The anchors arrive as the RAW form strings ('' for an empty control, "23" for a
// picked day) rather than numbers: that is the shape the form actually holds, and
// keeping the "is this even a usable anchor?" question here means the component
// never has a NaN branch of its own.

export type IntervalUnit = 'month' | 'week';

export interface Schedule {
  unit: IntervalUnit;
  /** Raw `day_of_month` form value; '' when the control is not in play. */
  dayOfMonth: string;
  /** Raw `weekday` form value (ISO 0 = Monday); '' when not in play. */
  weekday: string;
}

interface Ymd {
  year: number;
  month: number; // 1-based
  day: number;
}

const API_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Days in a 1-based (year, month): day 0 of the NEXT month is this one's last. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** "2026-08-23" -> parts, or null if it is not a real calendar date. */
function parseApiDate(isoDate: string): Ymd | null {
  if (!API_DATE.test(isoDate)) return null;
  const [year, month, day] = isoDate.split('-').map(Number);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

function toApiDate({ year, month, day }: Ymd): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** An anchor control's value as a whole number, or null when it is not one. */
function parseAnchor(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isInteger(value) ? value : null;
}

/**
 * The anchors a picked date implies: its day of the month AND its ISO weekday.
 *
 * `getUTCDay()` is 0 = SUNDAY; the wire (and `weekdayLabels`) is 0 = MONDAY, so
 * the `+ 6) % 7` shift is not cosmetic — six of the seven values look plausible
 * under either reading, which is exactly how an off-by-one weekday ships.
 *
 * Returns null for an empty or unparseable value: clearing the date must leave
 * the anchor alone, not reset it to something invented.
 */
export function anchorsForDate(isoDate: string): { dayOfMonth: number; weekday: number } | null {
  const parts = parseApiDate(isoDate.trim());
  if (parts === null) return null;
  const utc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  return { dayOfMonth: parts.day, weekday: (utc.getUTCDay() + 6) % 7 };
}

/**
 * The first date this schedule fires on, on or after `startDate`.
 *
 * null when the pair cannot answer the question: no start date, an unparseable
 * one, or an anchor that is missing/out of range for the chosen unit (the schema
 * refuses those on submit — the advisory line simply stays quiet meanwhile).
 */
export function firstChargeDate(schedule: Schedule, startDate: string): string | null {
  const start = parseApiDate(startDate.trim());
  if (start === null) return null;

  if (schedule.unit === 'month') {
    const day = parseAnchor(schedule.dayOfMonth);
    if (day === null || day < 1 || day > 31) return null;
    // This month's clamped due date if it has not passed, else next month's —
    // `next_due()`'s monthly arm, with ">= start" for its "> start - 1 day".
    const thisMonth = Math.min(day, daysInMonth(start.year, start.month));
    if (thisMonth >= start.day) {
      return toApiDate({ year: start.year, month: start.month, day: thisMonth });
    }
    const year = start.month === 12 ? start.year + 1 : start.year;
    const month = start.month === 12 ? 1 : start.month + 1;
    return toApiDate({ year, month, day: Math.min(day, daysInMonth(year, month)) });
  }

  const weekday = parseAnchor(schedule.weekday);
  if (weekday === null || weekday < 0 || weekday > 6) return null;
  const startUtc = new Date(Date.UTC(start.year, start.month - 1, start.day));
  const startWeekday = (startUtc.getUTCDay() + 6) % 7; // ISO, 0 = Monday
  const shifted = new Date(
    Date.UTC(start.year, start.month - 1, start.day + ((weekday - startWeekday + 7) % 7)),
  );
  return toApiDate({
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  });
}

/**
 * The first charge date when the schedule does NOT fire on the start date, else
 * null (no contradiction to warn about).
 *
 * Comparing DATES rather than "day of the month === picked day" is what makes the
 * clamp free: a template on day 31 starting 30 April fires on 30 April, so there
 * is nothing to warn about — a day-number compare would cry wolf.
 */
export function startDateConflict(schedule: Schedule, startDate: string): string | null {
  const firstCharge = firstChargeDate(schedule, startDate);
  if (firstCharge === null) return null;
  return firstCharge === startDate.trim() ? null : firstCharge;
}
