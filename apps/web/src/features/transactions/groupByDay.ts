import type { components } from '@budget/api-client';

type TransactionRead = components['schemas']['TransactionRead'];

export interface DayGroup {
  date: string; // "YYYY-MM-DD"
  items: TransactionRead[];
}

/**
 * Bucket a transaction list into per-day groups, PRESERVING the incoming order.
 * The server orders by occurred_at (DESC by default, ASC under `sort=date_asc`),
 * so same-day rows are contiguous and this single pass produces day groups in the
 * server's own date order without re-sorting (which could disturb its intra-day
 * tiebreak). Group boundaries fall wherever occurred_at changes — including across
 * a month boundary.
 *
 * Only called for the DATE orders (search-and-drilldown S3): under an amount sort
 * rows are not date-contiguous, so the list renders flat instead — see
 * `showsDayGroups` in txFilters.ts.
 */
export function groupByDay(transactions: TransactionRead[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const transaction of transactions) {
    const last = groups[groups.length - 1];
    if (last && last.date === transaction.occurred_at) {
      last.items.push(transaction);
    } else {
      groups.push({ date: transaction.occurred_at, items: [transaction] });
    }
  }
  return groups;
}
