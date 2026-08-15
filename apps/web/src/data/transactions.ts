// Transactions data layer (obligations T1/T2/T9). The month list is an infinite
// query (limit=200 per R4; offset is the page cursor — AM-1.6-a); the summary is a
// separate per-month query. After ANY tx mutation we invalidate the list (via the
// not-'summary' predicate) AND the affected month's summary — the aggregate is not
// locally recomputable (T9). An edit that moves occurred_at across a month boundary
// invalidates BOTH the old and new month's summary (the plan's #1 risk).
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
function invalidateTxLists(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({
    predicate: (query) =>
      query.queryKey[0] === 'transactions' && query.queryKey[1] !== 'summary',
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
    },
    // A 404 (TRANSACTION_NOT_FOUND) means the row was deleted elsewhere — refetch
    // the lists so the now-stale row disappears (T6/T9). The caller still routes
    // the error to the form via describeTransactionError.
    onError: (error) => {
      if (error instanceof ApiError && error.status === 404) {
        void invalidateTxLists(queryClient);
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
    },
    // Deleting a row another session already deleted returns 404; the dialog tells
    // the user it "no longer exists", so refetch the lists to make it disappear
    // (T6/T9). The caller still surfaces the error text via describeTransactionError.
    onError: (error) => {
      if (error instanceof ApiError && error.status === 404) {
        void invalidateTxLists(queryClient);
      }
    },
  });
}
