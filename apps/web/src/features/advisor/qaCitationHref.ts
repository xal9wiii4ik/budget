// Where a citation LEADS (rag Web A). Pure, language-free, no money.
import type { components } from '@budget/api-client';

import { txWindowHref } from '../transactions/txWindow';

type TransactionRead = components['schemas']['TransactionRead'];

/**
 * The /transactions link for one cited operation: that operation's ACCOUNT,
 * windowed to its own day.
 *
 * Chosen over the three alternatives, and the reasons are structural rather
 * than aesthetic:
 *
 *   * there is no single-transaction ROUTE, and inventing `?tx=<id>` would add a
 *     URL grammar plus a resolve-by-id that the cache cannot answer (the row is
 *     in a mutation response, not in any query entry);
 *   * a modal over /advisor would need the category and account indices, plus a
 *     whole edit form sitting inside a read-only answer;
 *   * `txWindowHref` is an ALREADY PINNED grammar (pdf-reconcile decision 5, the
 *     same link the reconcile report and the drill-down windows write), so the
 *     screen the user lands on is one the parser already knows how to rebuild.
 *
 * The one-day custom period rather than the row's month: a month of an account
 * can be hundreds of rows, and the point of a citation is to show THIS
 * operation, visible and editable, not to drop the reader somewhere near it.
 *
 * `account_id` is non-nullable in the contract, so the link always resolves —
 * there is no "no account" arm to render, and a citation can never be dead.
 */
export function qaCitationHref(
  transaction: Pick<TransactionRead, 'account_id' | 'occurred_at'>,
): string {
  return txWindowHref(
    { kind: 'account', accountId: transaction.account_id },
    // `occurred_at` is date-only (`YYYY-MM-DD`), which is exactly the custom
    // period's own format — no Date is built and no timezone is involved.
    { kind: 'custom', from: transaction.occurred_at, to: transaction.occurred_at },
  );
}
