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
import type { components, paths } from '@budget/api-client';

// search-and-drilldown S3: the sort order is an inline query enum, not a schema
// component, so the type is read off the generated PATH rather than redeclared by
// hand — a renamed or extended contract fails typecheck instead of drifting.
// The VALUES (and the "default = omitted" rule) live in
// features/transactions/txFilters.ts.
export type TxSort = NonNullable<
  NonNullable<paths['/transactions']['get']['parameters']['query']>['sort']
>;

export type TxListFilters = {
  // search-and-drilldown S1: BOTH optional, because the server declares them
  // optional and the list has an "all time" mode (`?range=all`) that simply omits
  // the window. Omitted rather than `undefined`-valued for the same reason as the
  // filters below — an unfiltered month keeps exactly the key it always had.
  from?: string;
  to?: string;
  // search-and-drilldown S1: the ONE category-filter mechanism on this screen —
  // fed by `?category=` (the drill-down from /categories today, the filter popover
  // in S3), never by a second piece of component state.
  category_id?: string;
  kind?: components['schemas']['TransactionKind'];
  // accounts-and-transfers W2: the account filter is DATA IN THE KEY, so a
  // filtered month and the all-accounts month are separate cache entries that can
  // never overwrite each other. Omitted (not `undefined`-valued) when no filter is
  // applied, so an unfiltered list keeps exactly the key it has always had. The
  // server matches EITHER leg of a transfer (architecture §6), so the same
  // transfer legitimately appears under both of its accounts' keys.
  account_id?: string;
  // search-and-drilldown S3, all three DATA IN THE KEY on the same terms as the
  // filters above — omitted (not `undefined`-valued) when unset, so the plain
  // month list keeps byte-for-byte the key it has always had:
  //   q       — the trimmed search text (the debounced value only: a key per
  //             keystroke would be a cache entry per keystroke);
  //   country — ISO 3166-1 alpha-2, uppercase;
  //   sort    — omitted for the server default (date_desc), so the default order
  //             has exactly ONE cache entry no matter how the URL spells it.
  q?: string;
  country?: string;
  sort?: TxSort;
  // goal-planner W2: the plan item (SUBTREE — PM Q4) whose spending a list is
  // showing. DATA IN THE KEY on exactly the terms above: omitted when unset, so
  // the plain month list keeps the key it has always had, and the shipped
  // list-invalidation predicate (`key[0]==='transactions' && key[1]!=='summary'`)
  // covers it for free. Declared here NOW because the tx form's attach picker
  // (this scope) is what fills the column; the CONSUMER — the node's operation
  // list inside PlanNodeDetails — lands in a later scope, and letting the two
  // arrive together would mean either a second filter grammar or a key change
  // under a shipped cache.
  goal_item_id?: string;
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
  // The /transactions upcoming-charges widget (recurring-dates-and-income W1)
  // joins the SAME root on purpose — the one place this codebase's "new feature,
  // new root" rule is bent, and for a concrete reason: `invalidateTemplates()`
  // invalidates the bare ['recurring'] prefix, so create / edit / pause-resume /
  // delete already refresh the widget with no new invalidation code, and a
  // template edit is precisely what changes the upcoming list. A disjoint root
  // would have to re-derive that and could drift out of sync with it.
  // `days` sits IN the key so a future horizon control is a parameter, not a
  // cache redesign. Transaction mutations deliberately do NOT invalidate it: the
  // endpoint reads templates + last_materialized_on, and a manual transaction
  // changes neither.
  recurringUpcoming: (days: number) => ['recurring', 'upcoming', { days }] as const,
  // Category limits (5.4 W4/W5) are a NEW top-level family, disjoint from every
  // shipped one, and month-scoped because a limit is a CALENDAR-MONTH budget
  // (D16): ['limits', { month }] means a past month on /stats and the current
  // month on /categories are separate cache entries that can never overwrite
  // each other. Conversely the three tx mutations invalidate the bare ['limits']
  // prefix (data/transactions.ts) — deliberately blanket, since an occurred_at
  // edit can move `spent_minor` in two different months at once.
  limits: (month: string) => ['limits', { month }] as const,
  // Personal access tokens (mcp-server S2) are a NEW top-level family, disjoint
  // from every shipped one, so no existing invalidation predicate touches them
  // and theirs touches nothing else. The list takes no parameters (GET /tokens
  // has none — unpaginated, revoked rows included), and the 'list' segment is
  // the same key[1] disambiguation goals/recurring use, so a future
  // ['tokens', id, …] sub-family cannot collide with it.
  tokens: () => ['tokens', 'list'] as const,
  // Remote MCP connector (mcp-remote W1). TWO new top-level roots, disjoint
  // from each other and from every shipped one:
  //
  //   oauthRequest(id) -> ['oauth-request', <id>]  GET /oauth/requests/{id}
  //   oauthApps()      -> ['oauth-apps', 'list']   GET /oauth/apps
  //
  // The pending authorization request is SINGLE-USE and its answer cannot
  // change while the page is open (only into the 404 the decision itself
  // produces), so it is `staleTime: Infinity` and nothing invalidates it.
  //
  // `POST /oauth/requests/{id}/decision` invalidates NOTHING, and the two roots
  // are disjoint for exactly that reason: the grant row — the thing
  // `['oauth-apps','list']` lists — is created at CODE EXCHANGE, not at consent
  // (architecture D3), so at decision time there is no connected app to refresh
  // (and the consent page navigates away to the client). Without this sentence
  // the missing invalidation would read as an omission.
  oauthRequest: (requestId: string) => ['oauth-request', requestId] as const,
  // The 'list' segment is the same key[1] disambiguation tokens/accounts use, so
  // a future ['oauth-apps', id, …] sub-family cannot collide with it. Only the
  // revoke (DELETE /oauth/apps/{id}) invalidates this root, and it touches
  // nothing else — in particular NOT ['tokens', …]: a grant and a PAT are
  // separate rows on separate screens, and the server refuses to cross-list them.
  oauthApps: () => ['oauth-apps', 'list'] as const,
  // Web push (web-push W1) is a NEW top-level family, disjoint from every
  // shipped one. Its ONLY cached entry is the server's push config — whether
  // VAPID keys are set, and the public one. The browser's own subscription is
  // browser state (`pushManager.getSubscription()`), never cached here. The
  // three /push writes invalidate nothing on success (no cached read changes);
  // a `PUSH_NOT_CONFIGURED` answer invalidates the bare ['push'] so the
  // refetched `enabled: false` flips the Settings section to its server-off arm.
  pushConfig: () => ['push', 'config'] as const,
  // Accounts (accounts-and-transfers W1) are a NEW top-level family, disjoint
  // from every shipped one, so no existing invalidation predicate touches them.
  // ONE archived-inclusive entry is the single source for the /accounts screen,
  // the four form selectors and the transfer row's account-name join (the
  // categories C5 pattern); the 'list' segment is the same key[1] disambiguation
  // goals/recurring/tokens use, so a future ['accounts', id, ...] sub-family
  // cannot collide with it. Conversely the three tx mutations invalidate the
  // bare ['accounts'] prefix (data/transactions.ts): every write moves a
  // balance, and a transfer moves two.
  accounts: () => ['accounts', 'list'] as const,
  // Deposits (deposits W1) are a NEW top-level family, disjoint from every
  // shipped one — including `['accounts', ...]`, deliberately: a deposit's ledger
  // account is HIDDEN from `GET /accounts` (architecture §"Поведение счетов типа
  // deposit"), so the two lists never describe the same rows and no shipped
  // predicate may reach across. ONE archive-inclusive entry (the endpoint takes
  // no `include_archived`) feeds the /deposits screen, the transfer form's
  // name/currency join and the /transactions account filter; views dim archived
  // rows client-side, the categories C5 pattern.
  //
  // Conversely the three tx mutations invalidate the bare `['deposits']` prefix
  // (data/transactions.ts): `balance_minor` and `accrued_minor` are SERVER
  // rollups over this account's transfers, so any money write can move them.
  depositsList: () => ['deposits', 'list'] as const,
  // Declared now, unread in W1: the screen renders from the list response, and
  // `GET /deposits/{id}` has no consumer yet. It exists so the sub-family's
  // shape is fixed before something starts inventing `['deposits', id]` keys
  // that collide with the 'list' segment above.
  depositDetail: (depositId: string) => ['deposits', depositId] as const,
  // Debts (debts W1) are a NEW top-level family, disjoint from every shipped one.
  // ONE status-inclusive entry (`GET /debts` takes no `?status=` — the response
  // carries every debt plus the base-currency `summary`) feeds three places: the
  // /debts screen, the /transactions "coming up" widget (the window is a pure
  // date filter over this cache — features/debts/debtDeadlines.ts, the
  // `depositDeadlines` twin, and the architecture adds no `/debts/upcoming`
  // endpoint for exactly that reason) and the `debt_id` row badge's name index.
  //
  // NOTHING outside the family invalidates it, and that is a fact about the
  // contract rather than an opinion: `/transactions` refuses PATCH and DELETE on
  // a movement row (422 `DEBT_MOVEMENT_READONLY`) and `TransactionCreate` carries
  // no debt field, so no tx write can move a debt figure. In the other direction
  // every debt write invalidates the bare `['accounts']` prefix and the tx LISTS
  // (data/debts.ts): a movement IS a transaction row and it moves a balance.
  debtsList: () => ['debts', 'list'] as const,
  // ONE debt with its repayments embedded (`GET /debts/{id}` → DebtDetailRead) —
  // read by the history window, which the list row's `repayments_count` alone
  // cannot fill. The 'list' segment above keeps this sub-family from colliding
  // with it; no debt id is the literal 'list'.
  debt: (debtId: string) => ['debts', debtId] as const,
  // The user profile (transaction-details-and-i18n S5) is a NEW top-level family,
  // disjoint from every shipped one. It takes no parameters (one profile per
  // user), and it is invalidated ONLY by its own PATCH — no other resource embeds
  // profile fields. The reverse direction is NOT symmetric since
  // base-currency-and-goal-basis (D3): a language change still makes nothing else
  // stale, but a BASE-CURRENCY change invalidates every family the server
  // computes in the base currency (goals / stats / limits / tx summaries — the
  // per-field branch lives in data/profile.ts).
  profile: () => ['profile'] as const,
  goalsList: (includeArchived: boolean) => ['goals', 'list', { includeArchived }] as const,
  // goal-planner W1. Two more members of the SAME per-goal sub-family, so the
  // existing `['goals', goalId]` invalidation (contributions today, plan writes
  // now) refreshes the plan screen wholesale, and `['goals','list']` still
  // touches neither:
  //   detail — GET /goals/{goal_id}. The plan screen reads the SINGLE response
  //            (Q6) instead of digging the goal out of a cached list: a deep
  //            link / F5 has no list in cache, and the single GET carries the
  //            full plan field set.
  //   items  — GET /goals/{goal_id}/items, the WHOLE tree in one request (the
  //            server ships a flat list with parent_id; the client only shapes
  //            it). No per-node key exists on purpose — that would be the N+1
  //            the architecture's recursive CTE exists to avoid.
  // goal-planner W2: the deadline/reminder widget on /transactions. It joins the
  // `['goals', ...]` root deliberately — the same bend of the "new feature, new
  // root" rule that `recurringUpcoming` makes, and for the same reason: every
  // plan write already invalidates a `['goals', ...]` prefix, and a linked
  // operation now does too (data/transactions.ts), so the widget refreshes with
  // no invalidation code of its own. `days` sits IN the key so a horizon control
  // would be a parameter, not a cache redesign. It can never collide with
  // `goalsList` / `goalDetail`: no goal id is the literal 'upcoming'.
  goalsUpcoming: (days: number) => ['goals', 'upcoming', { days }] as const,
  goalDetail: (goalId: string) => ['goals', goalId, 'detail'] as const,
  goalItems: (goalId: string) => ['goals', goalId, 'items'] as const,
  // goal-planner attachments (Q1). Deliberately UNDER `goalItems`' prefix rather
  // than a root of its own: the tree row carries `files_count` /
  // `subtree_files_count`, so a file write changes the tree AND this list, and
  // the one invalidation the plan already does (`['goals', goalId]`) has to
  // cover both. Per NODE, because the tree response ships counters only — a
  // presigned `view_url` per row of a 500-node plan is exactly what the counters
  // exist to avoid — so the list is fetched when a node's details are opened.
  goalItemFiles: (goalId: string, itemId: string) =>
    ['goals', goalId, 'items', itemId, 'files'] as const,
  // Statement imports (statement-import S4) are a NEW top-level family, disjoint
  // from every shipped one — nothing else describes a preview session, and no
  // shipped predicate may reach into it. Three members under one root:
  //   session — ['imports', id, 'session'], the counters apply/replace are
  //             confirmed against (architecture §10.4);
  //   rows    — ['imports', id, 'rows', {match_status, needs_review}], the paged
  //             preview. BOTH FILTERS are data in the key (the account-filter
  //             precedent): a chip is a different set of rows, not the same one
  //             re-read, so two views can never overwrite each other. They are
  //             independent and the server ANDs them, so "new AND needs a look"
  //             (ai-layer W1) is its own cache entry. `offset` stays the
  //             useInfiniteQuery pageParam (AM-1.6-a).
  //   replace-preview — every input in the key (the fx/convert precedent): the
  //             answer is a function of the date alone, so a moved date IS a
  //             different entry rather than an invalidation.
  // Conversely apply/replace invalidate the tx/stats/limits/accounts/goals
  // families through `invalidateAfterBulkTxWrite` (data/transactions.ts) plus
  // the bare ['imports', id] — the session's status and counters move with the
  // money it wrote.
  // The parser registry (bank-format-from-server): a STATIC server-owned
  // dictionary, not part of any session, so it sits beside them rather than
  // under an import id. It is deliberately reachable by NO existing predicate:
  // every invalidation and removal in the family is ['imports', <uuid>, ...],
  // and 'formats' is not a uuid — a cancelled import can never drop the list of
  // banks, and no mutation invalidates it at all.
  importFormats: () => ['imports', 'formats'] as const,
  importSession: (importId: string) => ['imports', importId, 'session'] as const,
  importRows: (importId: string, matchStatus: string | null, needsReview: boolean) =>
    ['imports', importId, 'rows', { match_status: matchStatus, needs_review: needsReview }] as const,
  importReplacePreview: (importId: string, from: string) =>
    ['imports', importId, 'replace-preview', { from }] as const,
  goalContributions: (goalId: string) => ['goals', goalId, 'contributions'] as const,
  goalProgress: (goalId: string, months: number) =>
    ['goals', goalId, 'progress', months] as const,
};
