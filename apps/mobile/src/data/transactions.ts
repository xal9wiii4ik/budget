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
//
// catch-up 3 line A: the number itself moved to features/transactions/txFilters.ts,
// beside the rest of the key grammar (the category screen builds list filters too,
// and a second page size would split one cache entry in two). This alias keeps every
// shipped call site — and the shipped name — unchanged.
export { TX_LIST_LIMIT as MONTH_LIMIT } from '../features/transactions/txFilters';

// occurred_at is date-only ("YYYY-MM-DD"); its month slice is the summary bucket.
function affectedMonth(occurredAt: string): string {
  return occurredAt.slice(0, 7);
}

// List-only invalidation: every ['transactions', ...] key EXCEPT the summary
// sub-family. Keeps a list change from blanket-refetching every month's summary.
// EXPORTED (catch-up 3, line B): deleting a recurring template SET NULLs
// `recurring_template_id` on the rows it already created, so every cached list
// row carries a dangling id until it is refetched. Money did not change — only
// the attribution — so data/recurring.ts calls THIS and nothing else.
export function invalidateTxLists(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({
    predicate: (query) =>
      query.queryKey[0] === 'transactions' && query.queryKey[1] !== 'summary',
  });
}

// The mirror image of `invalidateTxLists`: the summary sub-family ONLY.
// EXPORTED (mobile-catchup-1, mirror of web W1) — `SummaryRead` is computed by the
// server IN the profile base currency, so a base switch makes every cached month's
// summary stale while the LIST rows (which echo each transaction's stored base
// snapshot) come back byte-identical. The predicate lives here so the transactions
// key grammar stays in one file; data/profile.ts calls it.
export function invalidateTxSummaries(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({
    predicate: (query) =>
      query.queryKey[0] === 'transactions' && query.queryKey[1] === 'summary',
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

// --- stats invalidation (catch-up 3, line A) ---------------------------------
// Every tx write also blanket-invalidates the WHOLE ['stats', ...] family (mirror
// of web's WS-2). Blanket rather than surgical because ANY write can move ANY
// cached period: an occurred_at edit moves a row between two of them, a category
// change moves it between two buckets of the same one, and the client cannot know
// which periods a user has looked at without re-deriving the server's aggregation.
// It is a no-op until a stats entry has been fetched, so it costs nothing before
// the first visit to a category's operations.
function invalidateStats(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: ['stats'] });
}
// --- end stats invalidation (catch-up 3, line A) -----------------------------

// --- goals invalidation (catch-up 3, line C) ---------------------------------
// Copied from web data/transactions.ts, rule AND reason.
//
// The goals list's free balance (and everything derived from it) is computed from
// the last 3 FULL months of transactions, and deciding "did this write touch that
// window" client-side would re-implement the server's window logic. So every tx
// write blanket-invalidates the goals LIST; it is a no-op until the goals tab has
// been visited.
//
// That is NOT enough once an operation can be attached to a plan item: `paid` on
// the node, on each of its ancestors and on the goal, plus the deadline widget,
// are server rollups over the attached rows. Those live under
// `['goals', goalId, 'items'|'detail']` and `['goals','upcoming']` — none of which
// `['goals','list']` covers. So when the write TOUCHED a plan the BARE `['goals']`
// prefix goes (a superset of the list, hence the early return).
//
// The trigger is web's `touchesGoalPlan`, inlined here as the one expression it
// is: `before !== null || after !== null`. It is deliberately not "was anything
// about the row different" — an amount or a date edit on an ATTACHED operation
// moves the rollup just as much as attaching one does. `after` is null for a
// delete: nothing can still be attached to a row that is gone.
function invalidateGoalsAfterTx(
  queryClient: QueryClient,
  before: string | null,
  after: string | null,
): void {
  if (before !== null || after !== null) {
    void queryClient.invalidateQueries({ queryKey: ['goals'] });
    return;
  }
  void queryClient.invalidateQueries({ queryKey: ['goals', 'list'] });
}
// --- end goals invalidation (catch-up 3, line C) -----------------------------

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
      void invalidateStats(queryClient); // catch-up 3, line A
      // catch-up 3, line C: nothing was attached BEFORE a create.
      invalidateGoalsAfterTx(queryClient, null, created.goal_item_id);
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
      // catch-up 3, line C: the pre-edit `goal_item_id`, from the same row in
      // hand and for the same reason — the RESPONSE only says where the operation
      // is NOW, and detaching it (or moving it to another node) leaves the OLD
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
      void invalidateAccounts(queryClient);
      void invalidateStats(queryClient); // catch-up 3, line A
      // BOTH old and new month — occurred_at may have crossed a boundary. A Set
      // dedupes the common same-month case to a single summary invalidation (W8).
      const months = new Set([
        affectedMonth(variables.previousOccurredAt),
        affectedMonth(updated.occurred_at),
      ]);
      for (const month of months) {
        void queryClient.invalidateQueries({ queryKey: qk.txSummary(month) });
      }
      // catch-up 3, line C.
      invalidateGoalsAfterTx(
        queryClient,
        variables.previousGoalItemId,
        updated.goal_item_id,
      );
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
    mutationFn: async ({
      id,
    }: {
      id: string;
      occurredAt: string;
      // catch-up 3, line C: as on the update — the row in hand is the only place
      // this fact exists after the DELETE (204, no body).
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
      void invalidateAccounts(queryClient);
      void invalidateStats(queryClient); // catch-up 3, line A
      void queryClient.invalidateQueries({
        queryKey: qk.txSummary(affectedMonth(variables.occurredAt)),
      });
      // catch-up 3, line C: nothing can be attached to a row that no longer
      // exists, so "after" is null.
      invalidateGoalsAfterTx(queryClient, variables.previousGoalItemId, null);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 404) {
        void invalidateTxLists(queryClient);
      }
    },
  });
}
