// The gate in front of the ONLY irreversible action in this app: "replace
// everything from date X", which DELETES the account's operations in that range
// before re-filing the statement over it (architecture §7).
//
// Pure and separate from the dialog because this is the part that must not
// break: a checkbox can be ticked without reading, and a button can be clicked
// by muscle memory, so what unlocks the confirmation is the USER TYPING BACK the
// number of operations the server says it will delete. That number can only be
// obtained by reading the preview, and it is language-independent.
//
// The two ways this could quietly go wrong are both states, not events, so they
// are decided here rather than by an effect somewhere:
//
//   * the date moved after the number was typed — the preview on screen is then
//     about a DIFFERENT range, so the typed number confirms nothing;
//   * the preview is still loading, failed, or was refetched — there is no
//     number to compare against, and "no number" must never read as "matches".
//
// Both land in an arm that cannot submit. The caller additionally CLEARS the
// input on those transitions (a stale figure sitting in the box next to fresh
// figures is a lie about what is confirmed), but the safety does not depend on
// its doing so: this function alone decides whether the button may be pressed.

export interface ReplaceConfirmInput {
  /** The date the user picked (ISO), or '' when they have not picked one. */
  fromDate: string;
  /** The statement's own period — outside it the server refuses (§7). */
  periodFrom: string;
  periodTo: string;
  /** The date the preview ON SCREEN describes, or null when there is none. */
  previewFrom: string | null;
  /** `deleted_total` of that preview, or null while it is loading or failed. */
  previewDeletedTotal: number | null;
  /** Verbatim what the user typed into the confirmation box. */
  typed: string;
  /** True while the replace request is in flight. */
  isSubmitting: boolean;
}

export type ReplaceConfirmState =
  /** The request is on its way; nothing may be pressed again. */
  | { status: 'submitting' }
  /** No date yet. */
  | { status: 'needs_date' }
  /** A date the statement cannot cover: the server would refuse it too. */
  | { status: 'out_of_range' }
  /** A date, but no preview that describes THIS date. */
  | { status: 'needs_preview' }
  /** A preview is on screen; the typed number does not (yet) match it. */
  | { status: 'needs_confirmation'; deletedTotal: number; mismatch: boolean }
  /** Everything read and confirmed — and only here may the request be sent. */
  | { status: 'ready'; deletedTotal: number };

// Digits only. "-1", "1e3" and "1.0" are not the count printed on the screen, and
// accepting them would mean accepting something the user did not read off it.
const WHOLE_NUMBER = /^\d+$/;

export function replaceConfirmState(input: ReplaceConfirmInput): ReplaceConfirmState {
  if (input.isSubmitting) return { status: 'submitting' };
  if (input.fromDate === '') return { status: 'needs_date' };
  // ISO dates compare correctly as strings, which is why the whole app passes
  // them around in that form; no Date is constructed and no timezone enters.
  if (input.fromDate < input.periodFrom || input.fromDate > input.periodTo) {
    return { status: 'out_of_range' };
  }
  if (input.previewFrom !== input.fromDate || input.previewDeletedTotal === null) {
    return { status: 'needs_preview' };
  }

  const deletedTotal = input.previewDeletedTotal;
  const typed = input.typed.trim();
  if (typed === '') {
    return { status: 'needs_confirmation', deletedTotal, mismatch: false };
  }
  if (!WHOLE_NUMBER.test(typed) || Number(typed) !== deletedTotal) {
    return { status: 'needs_confirmation', deletedTotal, mismatch: true };
  }
  return { status: 'ready', deletedTotal };
}

/** The single answer the dialog's submit button asks for. */
export function canConfirmReplace(state: ReplaceConfirmState): boolean {
  return state.status === 'ready';
}
