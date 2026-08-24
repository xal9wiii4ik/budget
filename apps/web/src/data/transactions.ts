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
      void invalidateGoalsList(queryClient);
      void invalidateStats(queryClient);
      void invalidateLimits(queryClient);
      void invalidateAccounts(queryClient);
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
      void invalidateGoalsList(queryClient);
      void invalidateStats(queryClient);
      void invalidateLimits(queryClient);
      void invalidateAccounts(queryClient);
    },
    // A 404 (TRANSACTION_NOT_FOUND) means the row was deleted elsewhere — refetch
    // the lists so the now-stale row disappears (T6/T9). The caller still routes
    // the error to the form via describeTransactionError.
    onError: (error) => {
      if (error instanceof ApiError && error.status === 404) {
        void invalidateTxLists(queryClient);
        // The row is gone, so every cached balance that still counts it is wrong
        // — the same reason the lists are refetched here.
        void invalidateAccounts(queryClient);
      }
    },
  });
}

export function useDeleteTransaction() {
  const queryClient = useQueryClient();
  return useMutation({
    // 204 No Content: openapi-fetch resolves `data: undefined`, so throwOnError
    // (which treats undefined data as failure) can't be used — unwrap by hand.
    mutationFn: async ({ id }: { id: string; occurredAt: string }) => {
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
      void invalidateGoalsList(queryClient);
      void invalidateStats(queryClient);
      void invalidateLimits(queryClient);
      void invalidateAccounts(queryClient);
    },
    // Deleting a row another session already deleted returns 404; the dialog tells
    // the user it "no longer exists", so refetch the lists to make it disappear
    // (T6/T9). The caller still surfaces the error text via describeTransactionError.
    onError: (error) => {
      if (error instanceof ApiError && error.status === 404) {
        void invalidateTxLists(queryClient);
        // The row is gone, so every cached balance that still counts it is wrong
        // — the same reason the lists are refetched here.
        void invalidateAccounts(queryClient);
      }
    },
  });
}
