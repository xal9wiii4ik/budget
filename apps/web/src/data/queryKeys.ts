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
/**
 * The `/stats/*` period grammar (server D5), as a discriminated union of the
 * exact WIRE query objects. It is BOTH the request `params.query` and the query
 * key member — one source of truth for "which period am I looking at", so a
 * cached entry can never drift from the request that filled it.
 *
 * Exactly one anchor per unit: the server reads only the chosen unit's anchor,
 * and a stray `month=` alongside `period=year` is precisely what the picker must
 * never emit (features/stats/period.ts owns that mapping).
 */
export type StatsPeriodQuery =
  | { period: 'month'; month: string }
  | { period: 'quarter'; quarter: string }
  | { period: 'year'; year: number }
  | { period: 'custom'; from: string; to: string };

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
  // Stats (4.2) are a NEW top-level family, disjoint from ['transactions', ...]
  // so no existing invalidation predicate touches them — and conversely the tx
  // mutations invalidate the bare ['stats'] prefix (data/transactions.ts), which
  // is deliberately blanket: any write can move any cached period.
  statsSummary: (period: StatsPeriodQuery) => ['stats', 'summary', period] as const,
  // Monthly is NOT period-scoped (server D4: a trailing window ending at the
  // current month), so its key carries `months`, never a period object.
  statsMonthly: (months: number) => ['stats', 'monthly', { months }] as const,
  statsTopMerchants: (period: StatsPeriodQuery, limit: number) =>
    ['stats', 'top-merchants', period, { limit }] as const,
  // Recurring templates (5.3 W2) are a NEW top-level family, disjoint from
  // ['transactions', ...] / ['categories', ...] / ['stats', ...] / ['goals', ...],
  // so no shipped invalidation predicate touches them. It carries no parameters —
  // GET /recurring takes none (D10: all templates, no pagination, no filters) —
  // and the 'list' segment is the same key[1] disambiguation the goals family
  // uses, so a future per-template sub-family (['recurring', id, ...]) cannot
  // collide with it.
  recurringList: () => ['recurring', 'list'] as const,
  goalsList: (includeArchived: boolean) => ['goals', 'list', { includeArchived }] as const,
  goalContributions: (goalId: string) => ['goals', goalId, 'contributions'] as const,
  goalProgress: (goalId: string, months: number) =>
    ['goals', goalId, 'progress', months] as const,
};
