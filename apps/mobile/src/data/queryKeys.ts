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
import type { components, paths } from '@budget/api-client';

// --- transactions filters (catch-up 3, line A) --------------------------------
// The sort order is an inline query enum, not a schema component, so the type is
// read off the generated PATH rather than redeclared by hand — a renamed or
// extended contract fails typecheck instead of drifting. Same derivation as web's
// data/queryKeys.ts. The VALUES (and the "default = omitted" rule) live in
// features/transactions/txFilters.ts.
export type TxSort = NonNullable<
  NonNullable<paths['/transactions']['get']['parameters']['query']>['sort']
>;

// The `/stats/*` period grammar (server D5), copied from web's data/queryKeys.ts
// as a discriminated union of the exact WIRE query objects. It is BOTH the request
// `params.query` and the query key member — one source of truth for "which period
// am I looking at", so a cached entry can never drift from the request that filled
// it. Exactly one anchor per unit: a stray `month=` alongside `period=year` is what
// a picker must never emit. Mobile only ever builds the `month` and `custom` arms
// (features/categories/categoryDrilldown.ts), but the union is the server's whole
// grammar so a future screen cannot re-invent half of it.
export type StatsPeriodQuery =
  | { period: 'month'; month: string }
  | { period: 'quarter'; quarter: string }
  | { period: 'year'; year: number }
  | { period: 'custom'; from: string; to: string };

export type TxListFilters = {
  // catch-up 3 line A: BOTH optional now, because the server declares them optional
  // and the list grew an "all time" mode that simply omits the window. Omitted
  // rather than `undefined`-valued for the same reason as every filter below — the
  // unfiltered month keeps byte-for-byte the key it has always had.
  from?: string;
  to?: string;
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
  // catch-up 3 line A, all three DATA IN THE KEY on the same terms as the filters
  // above — omitted (not `undefined`-valued) when unset:
  //   q       — the trimmed search text (the DEBOUNCED value only: a key per
  //             keystroke would be a cache entry, and a request, per character);
  //   country — ISO 3166-1 alpha-2, uppercase (the shape the server validates);
  //   sort    — omitted for the server default (date_desc), so the default order
  //             has exactly ONE cache entry no matter how the screen spells it.
  q?: string;
  country?: string;
  sort?: TxSort;
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
  // --- recurring / settings (catch-up 3, line B) -----------------------------
  // Recurring templates (mirror of web data/queryKeys.ts). A NEW top-level
  // family, and the ONE place where two features deliberately SHARE a root:
  // `recurringUpcoming` sits under ['recurring', ...] so the existing bare
  // invalidation on create/PATCH/pause-resume/delete already refreshes the
  // widget — a paused template vanishes from it with no extra rule. Tx
  // mutations deliberately do NOT touch it (the endpoint reads templates and
  // their watermark, not transactions), and the 00:30 UTC materializer stays
  // unobserved exactly as it is on web.
  recurringList: () => ['recurring', 'list'] as const,
  recurringUpcoming: (days: number) => ['recurring', 'upcoming', { days }] as const,
  // --- end recurring / settings (catch-up 3, line B) --------------------------

  // Receipts (mobile-catchup-2) are a NEW top-level family, disjoint from
  // ['transactions', ...] and ['accounts', ...], so no existing invalidation
  // predicate touches them. There is no receipts LIST endpoint by design: the
  // only entry is the ONE receipt a transaction form is looking at.
  receipt: (receiptId: string) => ['receipts', receiptId] as const,
  // --- stats (catch-up 3, line A) --------------------------------------------
  // A NEW top-level family, disjoint from every shipped one, so no existing
  // invalidation predicate touches it — and conversely the three tx mutations now
  // invalidate the bare ['stats'] prefix (data/transactions.ts), deliberately
  // blanket: any write can move any cached period. The PERIOD OBJECT itself is the
  // key member, so a cached entry cannot drift from the request that filled it.
  // Only /stats/summary has a mobile consumer today (the category screen's
  // headline); the rest of web's stats screen is deliberately absent here.
  statsSummary: (period: StatsPeriodQuery) => ['stats', 'summary', period] as const,

  // --- goals (catch-up 3, line C) -------------------------------------------
  // COPIED VERBATIM from web's key grammar (data/queryKeys.ts), because the
  // invalidation rules are copied with them and a renamed segment would silently
  // stop matching a prefix. The `['goals', ...]` root has the same key[1]
  // disambiguation trick the transactions root uses:
  //   list:      ['goals', 'list', { includeArchived }]
  //   per-goal:  ['goals', <goalId>, 'detail' | 'items' | 'contributions']
  //   widget:    ['goals', 'upcoming', { days }]
  // so `['goals','list']` refreshes both list variants and no per-goal cache,
  // `['goals', goalId]` is one goal's whole sub-family, and the BARE `['goals']`
  // is everything.
  goalsList: (includeArchived: boolean) => ['goals', 'list', { includeArchived }] as const,
  // detail — GET /goals/{goal_id}. The plan screen reads the SINGLE response
  //          rather than digging the goal out of a cached list: a deep link has
  //          no list in cache, and the single GET carries the full plan field set.
  goalDetail: (goalId: string) => ['goals', goalId, 'detail'] as const,
  // items — GET /goals/{goal_id}/items, the WHOLE tree in one request (the server
  //         ships a flat list with parent_id; the client only shapes it). No
  //         per-node key exists on purpose — that would be the N+1 the server's
  //         recursive CTE exists to avoid.
  goalItems: (goalId: string) => ['goals', goalId, 'items'] as const,
  goalContributions: (goalId: string) => ['goals', goalId, 'contributions'] as const,
  // The deadline/reminder widget. It joins the `['goals', ...]` root DELIBERATELY
  // (web's comment): every plan write already invalidates a `['goals', ...]`
  // prefix, and a plan-touching transaction write invalidates the bare root, so
  // the widget refreshes with no invalidation code of its own. It can never
  // collide with `goalsList` / `goalDetail`: no goal id is the literal 'upcoming'.
  goalsUpcoming: (days: number) => ['goals', 'upcoming', { days }] as const,
  // A node's attachments, UNDER `goalItems`' prefix rather than a root of their
  // own: the tree row carries `files_count` / `subtree_files_count`, so a file
  // write changes the tree AND this list, and the one invalidation the plan
  // already does (`['goals', goalId]`) has to cover both. Per NODE, because the
  // tree ships counters only — a presigned `view_url` per row of a 500-node plan
  // is exactly what the counters exist to avoid.
  goalItemFiles: (goalId: string, itemId: string) =>
    ['goals', goalId, 'items', itemId, 'files'] as const,
  // --- end goals (catch-up 3, line C) ----------------------------------------
};
