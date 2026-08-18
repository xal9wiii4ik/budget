// Category limits data layer (5.4 W4, WR-2). One month-scoped read plus the two
// writes; nothing here recomputes anything the server folds.
//
// Invalidation matrix (T9 successor):
//
//   limit PUT / DELETE  -> ['limits']   (nothing else reads limit rows)
//   tx create/update/delete -> ['limits'] (in data/transactions.ts — `spent_minor`
//                                          moves, and WHICH month it moves in is
//                                          the server's window logic, not ours)
//
// The PUT response (`LimitRead`) is deliberately NOT written into the cache: it
// carries no `spent_minor`, so patching the list entry by hand would mean
// inventing one. An invalidation refetches the real pair instead.
import type { components } from '@budget/api-client';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { apiClient } from '../lib/api';
import { ApiError, throwOnError } from '../lib/query';
import { qk } from './queryKeys';

export type LimitsRead = components['schemas']['LimitsRead'];
export type LimitItem = components['schemas']['LimitItem'];

function invalidateLimits(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: ['limits'] });
}

/**
 * Every limit the user owns, each with its spend for `month` ("YYYY-MM").
 *
 * The month is ALWAYS sent explicitly, even for the current one: the server
 * would default to the current UTC month, while the cache key is built from the
 * caller's month string — sending it is what keeps the key and the response
 * talking about the same window (the client's local month and UTC's can differ
 * for a few hours around a month boundary).
 *
 * Two currencies live in this response and never mix (AM-5): `spent_minor` is in
 * `currency` (the current base), each `limit_minor` in its own stored
 * `limit_currency` stamp (D15). features/limits/limitProgress.ts is the only
 * place allowed to decide whether they are comparable.
 */
export function useLimits(month: string) {
  return useQuery<LimitsRead>({
    queryKey: qk.limits(month),
    queryFn: () => throwOnError(apiClient.GET('/limits', { params: { query: { month } } })),
  });
}

/**
 * Create or replace one category's limit (PUT is a full upsert — D17, so there
 * is no patch builder here). The amount is stamped by the server with the
 * CURRENT base currency, which is also why re-saving an existing limit is the
 * documented way out of a currency mismatch.
 */
export function useUpsertLimit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ categoryId, amountMinor }: { categoryId: string; amountMinor: number }) =>
      throwOnError(
        apiClient.PUT('/limits/{category_id}', {
          params: { path: { category_id: categoryId } },
          body: { amount_minor: amountMinor },
        }),
      ),
    onSuccess: () => {
      void invalidateLimits(queryClient);
    },
  });
}

export function useDeleteLimit() {
  const queryClient = useQueryClient();
  return useMutation({
    // 204 No Content: openapi-fetch resolves `data: undefined`, which throwOnError
    // treats as failure — unwrap by hand (the shipped delete precedent).
    mutationFn: async ({ categoryId }: { categoryId: string }) => {
      const { error, response } = await apiClient.DELETE('/limits/{category_id}', {
        params: { path: { category_id: categoryId } },
      });
      if (!response.ok || error !== undefined) {
        throw new ApiError(response.status, error);
      }
    },
    onSuccess: () => {
      void invalidateLimits(queryClient);
    },
    // LIMIT_NOT_FOUND: it is already gone (another tab, another device). Refetch
    // so the row disappears behind the message (the T6/T9 precedent).
    onError: (error) => {
      if (error instanceof ApiError && error.status === 404) {
        void invalidateLimits(queryClient);
      }
    },
  });
}
