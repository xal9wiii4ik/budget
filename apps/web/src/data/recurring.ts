// Recurring templates data layer (5.3 W2, WR-2). One unparameterised list query
// (`GET /recurring` takes no params — D10) plus the three writes.
//
// Invalidation matrix (T9 successor):
//
//   POST / PATCH        -> ['recurring']
//       The list is the only reader, and the transaction-list badge resolves its
//       NAME from this very cache (the 1.6 category name-cache pattern), so a
//       rename re-renders the badges with no transaction refetch at all.
//
//   DELETE              -> ['recurring'] + transaction LISTS
//       SL-C: the server SET NULLs `recurring_template_id` on the rows the
//       template already created, so every cached list row carries a dangling id
//       until it is refetched. Money did NOT change: deliberately NO summary, NO
//       ['stats'], NO ['goals'] invalidation.
//
// Nothing invalidates on MATERIALIZATION: rows appear from the 00:30 UTC job with
// no client event, and no polling or refetchInterval is added for a personal app
// with one run a day. The next natural refetch shows them (WR-2, recorded so it
// is not read as an oversight).
import type { components } from '@budget/api-client';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { apiClient } from '../lib/api';
import { ApiError, throwOnError } from '../lib/query';
import { qk } from './queryKeys';
import { invalidateTxLists } from './transactions';

export type RecurringTemplateRead = components['schemas']['RecurringTemplateRead'];
export type UpcomingChargeRead = components['schemas']['UpcomingChargeRead'];
type UpcomingChargeList = components['schemas']['UpcomingChargeList'];
type RecurringTemplateList = components['schemas']['RecurringTemplateList'];
type RecurringTemplateCreate = components['schemas']['RecurringTemplateCreate'];
type RecurringTemplateUpdate = components['schemas']['RecurringTemplateUpdate'];

function invalidateTemplates(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: ['recurring'] });
}

/**
 * Every template, including paused and ended ones (D10: the list IS the
 * management screen — a paused template is what the user came to resume and an
 * ended one is what they came to delete).
 *
 * `staleTime` mirrors the categories precedent: templates change rarely, and the
 * transactions screen mounts this same query for the badge index.
 */
export function useRecurringTemplates() {
  return useQuery<RecurringTemplateList>({
    queryKey: qk.recurringList(),
    queryFn: () => throwOnError(apiClient.GET('/recurring')),
    staleTime: 60_000,
  });
}

/**
 * The next `days` days of charges the live templates still owe
 * (recurring-dates-and-income W1) — the /transactions widget's only read.
 *
 * Same cache root as the list, `key[1]`-disambiguated, so `invalidateTemplates()`
 * above already covers it (see qk.recurringUpcoming for why that is deliberate).
 *
 * `staleTime` matches the list. The one writer nobody observes is the 00:30 UTC
 * materializer — a tab left open across midnight is stale exactly as /recurring
 * already is (WR-2), which is why there is no polling here either.
 */
export function useUpcomingCharges(days: number) {
  return useQuery<UpcomingChargeList>({
    queryKey: qk.recurringUpcoming(days),
    queryFn: () =>
      throwOnError(apiClient.GET('/recurring/upcoming', { params: { query: { days } } })),
    staleTime: 60_000,
  });
}

export function useCreateTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: RecurringTemplateCreate) =>
      throwOnError(apiClient.POST('/recurring', { body })),
    onSuccess: () => {
      void invalidateTemplates(queryClient);
    },
  });
}

export function useUpdateTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: RecurringTemplateUpdate }) =>
      throwOnError(
        apiClient.PATCH('/recurring/{template_id}', {
          params: { path: { template_id: id } },
          body,
        }),
      ),
    onSuccess: () => {
      void invalidateTemplates(queryClient);
    },
    onError: (error) => {
      // RECURRING_TEMPLATE_NOT_FOUND: someone else deleted it — refetch so the
      // stale row disappears behind the message (T6/T9 precedent).
      if (error instanceof ApiError && error.status === 404) {
        void invalidateTemplates(queryClient);
      }
    },
  });
}

export function useDeleteTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    // 204 No Content: openapi-fetch resolves `data: undefined`, which throwOnError
    // treats as failure — unwrap by hand (the shipped delete precedent).
    mutationFn: async ({ id }: { id: string }) => {
      const { error, response } = await apiClient.DELETE('/recurring/{template_id}', {
        params: { path: { template_id: id } },
      });
      if (!response.ok || error !== undefined) {
        throw new ApiError(response.status, error);
      }
    },
    onSuccess: () => {
      void invalidateTemplates(queryClient);
      // The attribution the server just dropped from the historic rows — the one
      // staleness window the client owns (SL-C / R3).
      void invalidateTxLists(queryClient);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 404) {
        void invalidateTemplates(queryClient);
      }
    },
  });
}
