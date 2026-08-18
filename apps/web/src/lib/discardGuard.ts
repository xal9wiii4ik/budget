/**
 * The dirty-form discard predicate (P2 / WR-11, obligation R6).
 *
 * Lives here, pure and alone, because it is the ONE rule the shared `Modal`
 * applies to all three close channels (Esc, backdrop, ×) for every form in the
 * app — and because the DOM behaviour around it is not testable in this repo's
 * node-only vitest setup, so the decidable part must be.
 *
 * Two arms, each of which a plausible wrong implementation gets wrong:
 *   - a CLEAN form closes immediately (confirming an unedited form is nagging,
 *     and it is the shipped behaviour of every modal that passes no `isDirty`);
 *   - a form whose submit/delete mutation is IN FLIGHT (`closeDisabled`) does not
 *     confirm either: the edits are already on their way to the server, so
 *     "discard your changes?" would be a question about something that has
 *     already happened. (`closeDisabled` also disables the × itself, and a dialog
 *     that must not close at all neutralizes its own `onClose` — the shipped
 *     `ConfirmDialog` pattern.)
 */
export function shouldConfirmDiscard(isDirty: boolean, closeDisabled: boolean): boolean {
  return isDirty && !closeDisabled;
}
