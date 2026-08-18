// The "Recurring" chip for a transaction row (5.3 W3, obligation R3).
//
// The NAME is not on the wire (D10: `TransactionRead` carries only
// `recurring_template_id`, deliberately, so a rename does not have to rewrite
// every row it ever created). It is resolved from the cached `['recurring','list']`
// query instead — the same name-cache pattern the category join uses.
//
// SL-C degradation: an id that does not resolve renders a NAME-LESS chip and NO
// special copy. A deleted template SET NULLs the column server-side, so a
// dangling id is only ever a transient cache-staleness window (the delete
// mutation invalidates the transaction lists to close the one window the client
// owns), and "created by a deleted template" would be a state that does not
// exist. The same arm covers a `/recurring` query that is still pending or has
// errored: the index is empty, the chip is name-less, no per-row spinner, no
// layout shift.
import type { components } from '@budget/api-client';

type TransactionRead = components['schemas']['TransactionRead'];

export type RecurringBadge = { name: string | undefined };

/**
 * `null` = this row was NOT created by a template, so there is no chip at all —
 * which is a different thing from a chip whose name is unknown. A naive
 * `index.get(id) ?? null` collapses those two into one and silently drops the
 * badge on every cache miss.
 */
export function recurringBadge(
  tx: TransactionRead,
  index: Map<string, { name: string }>,
): RecurringBadge | null {
  const templateId = tx.recurring_template_id;
  if (templateId === null) return null;
  return { name: index.get(templateId)?.name };
}
