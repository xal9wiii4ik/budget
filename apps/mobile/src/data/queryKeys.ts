// Hierarchical TanStack Query keys — COPIED verbatim from web data/queryKeys.ts
// (architect Q2). Two families live under the 'transactions' root, disambiguated by
// key[1]:
//   - list:    ['transactions', filters]           (filters is the STABLE slice)
//   - summary: ['transactions', 'summary', month]
// so the list-only invalidation predicate `key[1] !== 'summary'` never
// blanket-refetches every cached month's summary.
//
// AM-1.6-a: `offset` is the useInfiniteQuery page cursor (pageParam), NOT a key
// member — pages accumulate under one entry and invalidation refetches all loaded
// pages. `TxListFilters` is exactly the stable filter slice.
import type { components } from '@budget/api-client';

export type TxListFilters = {
  from: string;
  to: string;
  category_id?: string;
  kind?: components['schemas']['TransactionKind'];
  limit: number;
};

export const qk = {
  // AM-1.6-b: single archived-inclusive source; non-archived views are client-derived.
  categories: () => ['categories', { includeArchived: true }] as const,
  txList: (filters: TxListFilters) => ['transactions', filters] as const,
  txSummary: (month: string) => ['transactions', 'summary', month] as const,
};
