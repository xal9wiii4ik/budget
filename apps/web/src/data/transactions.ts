// Transactions data layer (obligations T1/T2/T9). The month list is an infinite
// query (limit=200 per R4; offset is the page cursor — AM-1.6-a); the summary is a
// separate per-month query. After ANY tx mutation we invalidate the list (via the
// not-'summary' predicate) AND the affected month's summary — the aggregate is not
// locally recomputable (T9). An edit that moves occurred_at across a month boundary
// invalidates BOTH the old and new month's summary (the plan's #1 risk). 4.2 adds
// a blanket ['stats'] invalidation to the same three mutations (WS-2 below).
import type { components } from '@budget/api-client';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';

import { apiClient } from '../lib/api';
import { ApiError, throwOnError } from '../lib/query';
import { touchesGoalPlan } from './goalPlanTouch';
import { qk, type TxListFilters } from './queryKeys';

type TransactionCreate = components['schemas']['TransactionCreate'];
type TransactionUpdate = components['schemas']['TransactionUpdate'];
type SummaryRead = components['schemas']['SummaryRead'];

// occurred_at is date-only ("YYYY-MM-DD"); its month slice is the summary bucket.
function affectedMonth(occurredAt: string): string {
  return occurredAt.slice(0, 7);
}

// List-only invalidation: every ['transactions', ...] key EXCEPT the summary
// sub-family. Keeps a list change from blanket-refetching every month's summary.
// EXPORTED since 5.3 (W2): a recurring-template DELETE nulls `recurring_template_id`
// on the rows it already created, so the cached LISTS are stale in exactly this
// shape — and the predicate belongs in one place rather than being retyped in
// data/recurring.ts. Nothing else about that delete touches money, so it
// deliberately invalidates no summary, no stats, no goals.
export function invalidateTxLists(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({
    predicate: (query) =>
      query.queryKey[0] === 'transactions' && query.queryKey[1] !== 'summary',
  });
}

// The mirror image of `invalidateTxLists`: the summary sub-family ONLY.
// EXPORTED since base-currency-and-goal-basis (W1) — `SummaryRead` is computed by
// the server IN the profile base currency (routers/transactions.py), so a base
// switch makes every cached month's summary stale while the LIST rows (which echo
// each transaction's stored base snapshot) come back byte-identical. Keeping the
// predicate here means the transactions key grammar still lives in exactly one
// file; data/profile.ts calls it rather than retyping `key[1] === 'summary'`.
export function invalidateTxSummaries(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({
    predicate: (query) =>
      query.queryKey[0] === 'transactions' && query.queryKey[1] === 'summary',
  });
}

// 3.2 WD-4: the goals screen's free balance (and everything derived from it —
// realism, months-to-target, the waterfall allocations) is computed from the last
// 3 FULL months of transactions. A current-month row doesn't move it (the partial
// month is excluded), but an edit or delete of a past-month row does — and
// deciding "did this mutation touch the window" client-side would re-implement
// the server's window logic, which D8/D12 forbid. So every tx mutation blanket-
// invalidates the goals LIST; it is a no-op until the goals screen has been
// visited, so it costs nothing for users who never open it.
function invalidateGoalsList(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: ['goals', 'list'] });
}

/**
 * goal-planner W2. `invalidateGoalsList` above is NOT enough once an operation can
 * be attached to a plan item: `paid_minor` on the node, on each of its ancestors
 * and on the goal, plus "still to find" in the deadline widget, are server rollups
 * over the attached rows (architecture §4). Those live under
 * `['goals', goalId, 'items']`, `['goals', goalId, 'detail']` and
 * `['goals','upcoming']` — none of which `['goals','list']` covers.
 *
 * So when `touchesGoalPlan` says this write touched a plan, the BARE `['goals']`
 * prefix is invalidated (a superset of the list, hence the early return) and the
 * whole family refreshes: node, ancestors, goal, widget. Blanket rather than
 * surgical for the usual reason — deciding WHICH ancestors moved would mean
 * re-implementing the server's rollup on the client, which is the money
 * arithmetic this project forbids; and the id in hand names a NODE, not the goal
 * whose sub-family the key is built from.
 *
 * When it did not, the behaviour is exactly what shipped before this scope.
 */
function invalidateGoalsAfterTx(
  queryClient: QueryClient,
  before: string | null,
  after: string | null,
): void {
  if (touchesGoalPlan(before, after)) {
    void queryClient.invalidateQueries({ queryKey: ['goals'] });
    return;
  }
  void invalidateGoalsList(queryClient);
}

// 4.2 WS-2: every tx write blanket-invalidates the WHOLE ['stats', ...] family.
// Deliberately not surgical — a write that changes occurred_at, amount_minor,
// currency, base_amount_minor, category_id, kind or merchant lands in some cached
// period, and deciding WHICH cached periods it touches client-side would
// re-implement the server's window and bucket logic (the same argument as the
// goals list above, and what D16 forbids in spirit). It is a no-op until /stats
// has been visited, so it costs nothing for users who never open it. Category
// and goal mutations deliberately do NOT invalidate stats: by_category is
// reference-by-id and the goals section reuses the ['goals'] cache.
function invalidateStats(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: ['stats'] });
}

// 5.4 WR-2: every tx write also blanket-invalidates the WHOLE ['limits', ...]
// family — verbatim the argument above. A write moves `spent_minor`, and an
// occurred_at edit can move it in TWO months at once (out of one, into another),
// so deciding which cached months changed client-side would re-implement the
// server's window logic. It is a no-op until /categories or /stats has been
// visited, so it costs nothing for users who never open them.
function invalidateLimits(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: ['limits'] });
}

// accounts-and-transfers W1: every tx write also blanket-invalidates the WHOLE
// ['accounts', ...] family. `balance_minor` is a SERVER-COMPUTED sum over the
// rows of an account (architecture §2), so any create/edit/delete moves it — and
// a transfer moves TWO balances at once. Blanket rather than surgical on purpose:
// deciding WHICH accounts a write touched would mean re-implementing the server's
// balance formula on the client (a PATCH can move a row between accounts, and the
// pre-edit account is not in the response), which is exactly the money arithmetic
// this project forbids. It is a no-op until an account list has been fetched, so
// it costs nothing before the first /accounts visit or form open.
function invalidateAccounts(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: ['accounts'] });
}

// deposits W1: every tx write ALSO blanket-invalidates the whole `['deposits',
// ...]` family, right beside the accounts one and for the same reason. A
// deposit's `balance_minor` is a server rollup over the transfers on its hidden
// ledger account, and `accrued_minor` is computed FROM that timeline, so a
// top-up, a withdrawal or an edit to either moves both numbers.
//
// Blanket rather than conditional, on purpose: the write in hand does not say
// whether it touched a deposit. A PATCH can move a transfer OFF a deposit
// account, and the pre-edit account is not in the response — deciding "this one
// was not a deposit" would need exactly the state the client does not have. The
// cost is one small GET after a write once the deposits list has been fetched
// at all (a no-op before that); the alternative is a deposit body that silently
// goes stale after the top-up that changed it.
function invalidateDeposits(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: ['deposits'] });
}

/**
 * Everything a BATCH transaction write makes stale (statement-import S4).
 *
 * A statement apply or replace creates — and, on the replace path, deletes —
 * up to a thousand rows in ONE server call, so the per-mutation invalidations
 * above cannot be reused row by row: there is no response row to read a month
 * off, and no "before" value for anything. It is therefore blanket by
 * construction, and deliberately so: every family below is a server rollup over
 * the rows that just moved (list, per-month summaries, stats, budgets, account
 * balances, the goals list), and deciding WHICH month or which account changed
 * client-side would re-implement the server's own selection.
 *
 * The goals side stops at `['goals','list']`: an import can attach nothing to a
 * plan item (no statement row carries a `goal_item_id`), so the plan rollups the
 * bare `['goals']` prefix exists for cannot have moved — what CAN move is the
 * free balance, which is exactly what the list carries. Deposits are left out on
 * the same reasoning: a statement row is always an expense or an income on the
 * chosen account, never a transfer, and a deposit's ledger is fed by transfers
 * alone.
 *
 * Exported from here rather than written out in data/imports.ts so the key
 * grammar of these families keeps living in ONE file.
 */
export function invalidateAfterBulkTxWrite(queryClient: QueryClient): void {
  void invalidateTxLists(queryClient);
  void invalidateTxSummaries(queryClient);
  void invalidateStats(queryClient);
  void invalidateLimits(queryClient);
  void invalidateAccounts(queryClient);
  void invalidateGoalsList(queryClient);
}

export function useTransactions(filters: TxListFilters) {
  return useInfiniteQuery({
    queryKey: qk.txList(filters),
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      throwOnError(
        apiClient.GET('/transactions', {
          params: { query: { ...filters, offset: pageParam } },
        }),
      ),
    // has_more is derived: sum of loaded items vs the total any page reports.
    getNextPageParam: (_lastPage, pages) => {
      const loaded = pages.reduce((count, page) => count + page.items.length, 0);
      const total = pages[0]?.total ?? 0;
      return loaded < total ? loaded : undefined;
    },
  });
}

export function useSummary(month: string) {
  return useQuery<SummaryRead>({
    queryKey: qk.txSummary(month),
    queryFn: () =>
      throwOnError(
        apiClient.GET('/transactions/summary', { params: { query: { month } } }),
      ),
  });
}

/**
 * The filter slice an export accepts (4.5 W4): the LIST's filters minus the
 * pagination pair. `limit`/`offset` are deliberately not sent — an export is the
 * whole matching set, not the page you happen to be looking at (D13).
 *
 * `sort` is out too (search-and-drilldown S3): GET /transactions/export takes no
 * such parameter — the CSV is documented as oldest-first whatever the screen's
 * order is — so this type makes sending one a compile error rather than a 422.
 * `q` and `country` ARE accepted there and stay in.
 */
export type ExportFilters = Omit<TxListFilters, 'limit' | 'sort'>;

/**
 * CSV export. A MUTATION, not a query: it is a user-triggered side effect that
 * produces a file, and caching a blob under a query key would be wrong on every
 * axis (it invalidates nothing, revalidates nothing and must re-run on every
 * press). It therefore also fires NO invalidation — it is a pure read.
 *
 * `parseAs: 'blob'` is a documented openapi-fetch option; the generated
 * `text/csv` 200 resolves through it to a `Blob`, so no cast is needed anywhere
 * on this path. Note that openapi-fetch re-parses the ERROR body as text->JSON
 * regardless of `parseAs`, so `ApiError.body` still carries the {detail} envelope
 * the shipped error machinery expects.
 */
export function useExportTransactions() {
  return useMutation({
    mutationFn: (query: ExportFilters): Promise<Blob> =>
      throwOnError(
        apiClient.GET('/transactions/export', { params: { query }, parseAs: 'blob' }),
      ),
  });
}

export function useCreateTransaction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: TransactionCreate) =>
      throwOnError(apiClient.POST('/transactions', { body })),
    onSuccess: (created) => {
      void invalidateTxLists(queryClient);
      void queryClient.invalidateQueries({
        queryKey: qk.txSummary(affectedMonth(created.occurred_at)),
      });
      // A create has no "before": the row did not exist, so only the RESPONSE can
      // say whether it landed on a plan item.
      invalidateGoalsAfterTx(queryClient, null, created.goal_item_id);
      void invalidateStats(queryClient);
      void invalidateLimits(queryClient);
      void invalidateAccounts(queryClient);
      void invalidateDeposits(queryClient);
    },
  });
}

export function useUpdateTransaction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: string;
      body: TransactionUpdate;
      // The pre-edit occurred_at, captured from the row already in hand — no
      // GET /{id} exists. Used to invalidate the OLD month when the date moves.
      previousOccurredAt: string;
      // goal-planner W2: the pre-edit `goal_item_id`, from the same row in hand
      // and for the same reason — the RESPONSE only says where the operation is
      // NOW, and detaching it (or moving it to another node) leaves the OLD
      // node's rollup stale. Required, not optional: the caller always holds the
      // row it opened the form from, and a forgotten value would be a silent
      // wrong invalidation rather than a compile error.
      previousGoalItemId: string | null;
    }) =>
      throwOnError(
        apiClient.PATCH('/transactions/{transaction_id}', {
          params: { path: { transaction_id: id } },
          body,
        }),
      ),
    onSuccess: (updated, variables) => {
      void invalidateTxLists(queryClient);
      // BOTH old and new month — occurred_at may have crossed a boundary. A Set
      // dedupes the common same-month case to a single summary invalidation.
      const months = new Set([
        affectedMonth(variables.previousOccurredAt),
        affectedMonth(updated.occurred_at),
      ]);
      for (const month of months) {
        void queryClient.invalidateQueries({ queryKey: qk.txSummary(month) });
      }
      invalidateGoalsAfterTx(
        queryClient,
        variables.previousGoalItemId,
        updated.goal_item_id,
      );
      void invalidateStats(queryClient);
      void invalidateLimits(queryClient);
      void invalidateAccounts(queryClient);
      void invalidateDeposits(queryClient);
    },
    // A 404 (TRANSACTION_NOT_FOUND) means the row was deleted elsewhere — refetch
    // the lists so the now-stale row disappears (T6/T9). The caller still routes
    // the error to the form via describeTransactionError.
    onError: (error) => {
      if (error instanceof ApiError && error.status === 404) {
        void invalidateTxLists(queryClient);
        // The row is gone, so every cached balance that still counts it is wrong
        // — the same reason the lists are refetched here. A deposit body is the
        // same kind of stale sum, so it goes too.
        void invalidateAccounts(queryClient);
        void invalidateDeposits(queryClient);
      }
    },
  });
}

export function useDeleteTransaction() {
  const queryClient = useQueryClient();
  return useMutation({
    // 204 No Content: openapi-fetch resolves `data: undefined`, so throwOnError
    // (which treats undefined data as failure) can't be used — unwrap by hand.
    mutationFn: async ({
      id,
    }: {
      id: string;
      occurredAt: string;
      // As on the update: the row in hand is the only place this fact exists
      // after the DELETE (204, no body).
      previousGoalItemId: string | null;
    }) => {
      const { error, response } = await apiClient.DELETE('/transactions/{transaction_id}', {
        params: { path: { transaction_id: id } },
      });
      if (!response.ok || error !== undefined) {
        throw new ApiError(response.status, error);
      }
    },
    onSuccess: (_result, variables) => {
      void invalidateTxLists(queryClient);
      void queryClient.invalidateQueries({
        queryKey: qk.txSummary(affectedMonth(variables.occurredAt)),
      });
      // Nothing can be attached to a row that no longer exists, so "after" is null.
      invalidateGoalsAfterTx(queryClient, variables.previousGoalItemId, null);
      void invalidateStats(queryClient);
      void invalidateLimits(queryClient);
      void invalidateAccounts(queryClient);
      void invalidateDeposits(queryClient);
    },
    // Deleting a row another session already deleted returns 404; the dialog tells
    // the user it "no longer exists", so refetch the lists to make it disappear
    // (T6/T9). The caller still surfaces the error text via describeTransactionError.
    onError: (error) => {
      if (error instanceof ApiError && error.status === 404) {
        void invalidateTxLists(queryClient);
        // The row is gone, so every cached balance that still counts it is wrong
        // — the same reason the lists are refetched here. A deposit body is the
        // same kind of stale sum, so it goes too.
        void invalidateAccounts(queryClient);
        void invalidateDeposits(queryClient);
      }
    },
  });
}
