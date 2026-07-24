// Bucket a transaction list into per-day groups PRESERVING the incoming order.
// Copied from web features/transactions/groupByDay.ts. The server returns
// occurred_at-DESC, so same-day rows are contiguous and this single pass produces
// day groups in descending date order without re-sorting (which could disturb the
// server's intra-day tiebreak). Feeds the SectionList sections.
import type { components } from '@budget/api-client';

type TransactionRead = components['schemas']['TransactionRead'];

export interface DayGroup {
  date: string; // "YYYY-MM-DD"
  items: TransactionRead[];
}

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
