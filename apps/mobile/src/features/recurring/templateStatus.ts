// VERBATIM COPY of apps/web/src/features/recurring/templateStatus.ts (catch-up 3, line B):
// same rule, same wording of the decisions, and web's own vitest file already
// pins it — a second identical test on this side would only re-assert it.
// The template's display state, DERIVED FROM SERVER FIELDS ONLY (WR-5 / R2).
//
// Nothing here parses, compares or computes a date. `next_due_on` is the server's
// answer to "when will this next book a row" (floored at today — OQ-1), and
// `end_date` is shown for information, never compared to today: an "ended" badge
// that the client decided would be a second, quietly disagreeing implementation
// of the server's end-condition rule (D4).
import type { RecurringTemplateRead } from '../../data/recurring';

export type TemplateStatus =
  | { status: 'paused' }
  | { status: 'ended'; endDate: string | null }
  | { status: 'active'; nextDueOn: string };

/**
 * PAUSED WINS. The server returns `next_due_on: null` when the template is paused
 * OR when it has run past its end date, so the flag is the ONLY thing that can
 * tell the two apart — checking `next_due_on` first would label every paused
 * template "Ended" and offer a delete where a resume belongs.
 */
export function templateStatus(template: RecurringTemplateRead): TemplateStatus {
  if (template.paused) return { status: 'paused' };
  if (template.next_due_on === null) {
    return { status: 'ended', endDate: template.end_date };
  }
  return { status: 'active', nextDueOn: template.next_due_on };
}
