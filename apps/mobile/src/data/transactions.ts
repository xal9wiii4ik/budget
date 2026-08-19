// Transactions data layer (W6/W8). The month list is an infinite query (limit in
// the stable filter slice; offset is the page cursor — AM-1.6-a); the summary is a
// separate per-month query. After ANY tx mutation we invalidate the list (via the
// not-'summary' predicate — W8) AND the affected month's summary; an edit that moves
// occurred_at across a month boundary invalidates BOTH months via a Set (W8).
// Copied from web data/transactions.ts (only api/query import paths differ).
import type { components } from '@budget/api-client';
import { ApiError, throwOnError } from '@budget/api-client';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';

import { apiClient } from '../lib/api';
import { qk, type TxListFilters } from './queryKeys';

type TransactionCreate = components['schemas']['TransactionCreate'];
type TransactionUpdate = components['schemas']['TransactionUpdate'];
type SummaryRead = components['schemas']['SummaryRead'];

// The month-list page size. Exported so the transactions tab AND the form modal
// reconstruct the IDENTICAL filter slice (hence the same query key / shared cache)
// when the modal locates its edit row from the cached month list.
export const MONTH_LIMIT = 200;

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

// accounts-and-transfers MOB (mirror of web W1): every tx write also blanket-
// invalidates the WHOLE ['accounts', ...] family. `balance_minor` is a
// SERVER-COMPUTED sum over the rows of an account (architecture §2), so any
// create/edit/delete moves it — and a transfer moves TWO balances at once.
// Blanket rather than surgical on purpose: deciding WHICH accounts a write
// touched would mean re-implementing the server's balance formula on the client
// (a PATCH can move a row between accounts, and the pre-edit account is not in
// the response), which is exactly the money arithmetic this project forbids. It
// is a no-op until an account list has been fetched, so it costs nothing before
// the first accounts-tab visit or form open.
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
    // has_more derived: sum of loaded items vs the total any page reports (W6).
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
      throwOnError(apiClient.GET('/transactions/summary', { params: { query: { month } } })),
  });
}

export function useCreateTransaction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: TransactionCreate) =>
      throwOnError(apiClient.POST('/transactions', { body })),
    onSuccess: (created) => {
      void invalidateTxLists(queryClient);
      void invalidateAccounts(queryClient);
      void queryClient.invalidateQueries({
        queryKey: qk.txSummary(affectedMonth(created.occurred_at)),
      });
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
      void invalidateAccounts(queryClient);
      // BOTH old and new month — occurred_at may have crossed a boundary. A Set
      // dedupes the common same-month case to a single summary invalidation (W8).
      const months = new Set([
        affectedMonth(variables.previousOccurredAt),
        affectedMonth(updated.occurred_at),
      ]);
      for (const month of months) {
        void queryClient.invalidateQueries({ queryKey: qk.txSummary(month) });
      }
    },
    // A 404 (TRANSACTION_NOT_FOUND) means the row was deleted elsewhere — refetch
    // the lists so the now-stale row disappears. The caller still routes the error
    // to the form via describeTransactionError.
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
      void invalidateAccounts(queryClient);
      void queryClient.invalidateQueries({
        queryKey: qk.txSummary(affectedMonth(variables.occurredAt)),
      });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 404) {
        void invalidateTxLists(queryClient);
      }
    },
  });
}
