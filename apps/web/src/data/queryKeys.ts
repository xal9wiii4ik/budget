// Hierarchical TanStack Query keys for the 1.6 data layer. Two families live under
// the `'transactions'` root and are disambiguated by key[1]:
//   - list:    ['transactions', filters]           (filters is the STABLE slice)
//   - summary: ['transactions', 'summary', month]
// so the list-only invalidation predicate `key[1] !== 'summary'` (see
// data/transactions.ts) never blanket-refetches every cached month's summary.
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

// GET /fx/convert preview inputs (3.2 WD-3/WD-4). Every input is part of the key,
// so a preview is never invalidated — a changed input simply IS a different entry
// (rates are daily; staleTime covers refires).
export type FxConvertParams = {
  amountMinor: number;
  from: string;
  to: string;
  date: string;
};

// The `['goals', ...]` root has the same key[1] disambiguation trick as
// transactions (3.2 WD-4):
//   list:          ['goals', 'list', { includeArchived }]
//   per-goal:      ['goals', <goalId>, 'contributions' | 'progress', ...]
// so invalidating the prefix ['goals','list'] refreshes both list variants and no
// per-goal cache, while ['goals', goalId] is one goal's whole sub-family and the
// bare ['goals'] prefix is everything.
export const qk = {
  // C5/Q5: single archived-inclusive source; non-archived views are client-derived.
  categories: () => ['categories', { includeArchived: true }] as const,
  txList: (filters: TxListFilters) => ['transactions', filters] as const,
  txSummary: (month: string) => ['transactions', 'summary', month] as const,
  // `null` = the disabled state (inputs incomplete); it keeps a stable key while
  // the query is skipped instead of colliding with a real parameter set.
  fxConvert: (params: FxConvertParams | null) => ['fx', 'convert', params] as const,
  // Receipts (S5) are a NEW top-level family, disjoint from ['transactions', ...]
  // and ['categories', ...] so no existing invalidation predicate touches them.
  // There is no receipts LIST endpoint by design: the only entry is one receipt
  // being polled by the open capture modal, and its cache is removed on close.
  receipt: (receiptId: string) => ['receipts', receiptId] as const,
  goalsList: (includeArchived: boolean) => ['goals', 'list', { includeArchived }] as const,
  goalContributions: (goalId: string) => ['goals', goalId, 'contributions'] as const,
  goalProgress: (goalId: string, months: number) =>
    ['goals', goalId, 'progress', months] as const,
};
