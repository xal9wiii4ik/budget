// "When will this reminder actually fire?" — the line under the reminder control
// in the item form (goal-planner W1, architecture §6). A COPY of web's
// features/goals/plan/remindPreview.ts: the rule is NOT rewritten here, so web's
// vitest stays the one place it is pinned.
//
// What is STORED is the INTENT, exactly one of two: a fixed date that stands
// still, or "N days before", which rides the EFFECTIVE deadline (the node's own,
// else the one it inherits). The fired date is never stored, so the form has to
// show it — otherwise "14 days before" is a number the user cannot check.
//
// This is a PREVIEW of the user's current input, not a claim about stored state:
// on READ the effective deadline comes from the server's CTE, and this module is
// only ever fed that server value. The one calculation is calendar-component
// arithmetic (the `dates.ts` house pattern: `new Date(y, m - 1, d)` never an ISO
// parse), which is TZ-safe and lets Date normalise month/leap rollover.
import { toApiDate } from '@budget/shared';

/** Which of the two intents the form is currently expressing. */
export type RemindMode = 'none' | 'on' | 'days';

export type RemindPreview =
  // No reminder asked for — or the chosen mode has no value typed into it yet.
  | { status: 'none' }
  // "N days before" with nothing to count back from: the node inherits no
  // deadline either, so the reminder honestly has no date (the server stores the
  // intent anyway — set a deadline later and it starts working).
  | { status: 'no-deadline' }
  | { status: 'date'; date: string };

export interface RemindPreviewInput {
  mode: RemindMode;
  /** The fixed date, "YYYY-MM-DD" or null/"" while empty. */
  remindOn: string | null;
  /** Days before the effective deadline, or null while empty/unparsed. */
  remindDaysBefore: number | null;
  /** `effective_deadline` from the server (own date, else inherited). */
  effectiveDeadline: string | null;
}

export function remindPreview(input: RemindPreviewInput): RemindPreview {
  if (input.mode === 'on') {
    const on = input.remindOn;
    return on === null || on === '' ? { status: 'none' } : { status: 'date', date: on };
  }

  if (input.mode === 'days') {
    if (input.remindDaysBefore === null) return { status: 'none' };
    const deadline = input.effectiveDeadline;
    if (deadline === null || deadline === '') return { status: 'no-deadline' };
    const [year, month, day] = deadline.split('-').map(Number);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
      return { status: 'none' };
    }
    return {
      status: 'date',
      date: toApiDate(new Date(year, month - 1, day - input.remindDaysBefore)),
    };
  }

  return { status: 'none' };
}
