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
  // accounts-and-transfers MOB (mirror of web W2): the account filter is DATA IN
  // THE KEY, so a filtered month and the all-accounts month are separate cache
  // entries that can never overwrite each other. OMITTED (not `undefined`-valued)
  // when nothing is filtered, so an unfiltered list keeps exactly the key it has
  // always had and no shipped entry is invalidated. The server matches EITHER leg
  // of a transfer, so the same transfer legitimately appears under both of its
  // accounts' keys.
  account_id?: string;
  limit: number;
};

// GET /fx/convert preview inputs (mobile-catchup-2, copied from web). Every
// input is part of the key, so a preview is never invalidated — a changed input
// simply IS a different entry (rates are daily; staleTime covers refires).
export type FxConvertParams = {
  amountMinor: number;
  from: string;
  to: string;
  date: string;
};

export const qk = {
  // The user profile (mobile-catchup-1, mirror of web data/queryKeys.ts): a NEW
  // top-level family, parameterless (one profile per user), disjoint from every
  // shipped one — no existing invalidation predicate touches it. It carries the
  // interface LANGUAGE, which is why it is fetched before any screen renders copy.
  profile: () => ['profile'] as const,
  // AM-1.6-b: single archived-inclusive source; non-archived views are client-derived.
  categories: () => ['categories', { includeArchived: true }] as const,
  // accounts-and-transfers MOB: a NEW top-level family, disjoint from every
  // shipped one, so no existing invalidation predicate touches it. ONE
  // archived-inclusive entry is the single source for the accounts tab, the form
  // pickers, the account filter and the transfer row's account-name join (the
  // same AM-1.6-b argument as categories). Conversely the three tx mutations
  // invalidate the bare ['accounts'] prefix (data/transactions.ts): every write
  // moves a server-computed balance, and a transfer moves two.
  accounts: () => ['accounts', { includeArchived: true }] as const,
  txList: (filters: TxListFilters) => ['transactions', filters] as const,
  txSummary: (month: string) => ['transactions', 'summary', month] as const,
  // `null` = the disabled state (inputs incomplete); it keeps a stable key while
  // the query is skipped instead of colliding with a real parameter set.
  fxConvert: (params: FxConvertParams | null) => ['fx', 'convert', params] as const,
  // Receipts (mobile-catchup-2) are a NEW top-level family, disjoint from
  // ['transactions', ...] and ['accounts', ...], so no existing invalidation
  // predicate touches them. There is no receipts LIST endpoint by design: the
  // only entry is the ONE receipt a transaction form is looking at.
  receipt: (receiptId: string) => ['receipts', receiptId] as const,
};
