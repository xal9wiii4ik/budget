// Goals data layer (3.2 W3/W4, WD-4). Everything the goals screen renders —
// saved totals, realism, months-to-target, the waterfall allocations, the free
// balance — is SERVER-COMPUTED (D12). Nothing here recomputes any of it locally,
// so every mutation ends in an invalidation rather than a cache patch:
//
//   goal CRUD          -> ['goals']            (list + every per-goal family; a
//                                               delete/archive makes the per-goal
//                                               caches garbage anyway)
//   contribution write -> ['goals','list']     (saved/realism/waterfall move, and
//                                               a completing goal frees its share
//                                               for OTHER goals — the cards read
//                                               the list, so one invalidation
//                                               covers the whole portfolio)
//                       + ['goals', goalId]    (that goal's contributions AND its
//                                               progress series; other goals'
//                                               per-goal caches stay warm)
//
// 404 onError refetches follow the T6/T9 precedent: a row someone else deleted
// must disappear from the screen, and the caller still routes the message to the
// form/dialog via describeGoalError / describeContributionError.
import type { components } from '@budget/api-client';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';

import { apiClient } from '../lib/api';
import { ApiError, throwOnError } from '../lib/query';
import { qk } from './queryKeys';

type GoalListRead = components['schemas']['GoalListRead'];
export type GoalRead = components['schemas']['GoalRead'];
type GoalCreate = components['schemas']['GoalCreate'];
type GoalUpdate = components['schemas']['GoalUpdate'];
type ContributionCreate = components['schemas']['ContributionCreate'];
export type ContributionRead = components['schemas']['ContributionRead'];
export type ProgressPoint = components['schemas']['ProgressPoint'];

// The server caps `limit` at 200; one page covers any realistic ledger, and the
// envelope's `total` drives "Load more" beyond that (the T1 ruling).
const CONTRIBUTIONS_PAGE_SIZE = 200;

// Months in the progress series. Fixed (not user-selectable) for now: the chart
// is a fixed-height card section, not a screen of its own.
export const PROGRESS_MONTHS = 12;

function invalidateGoalsList(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: ['goals', 'list'] });
}

function invalidateGoal(queryClient: QueryClient, goalId: string): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: ['goals', goalId] });
}

function invalidateAllGoals(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: ['goals'] });
}

export function useGoals(includeArchived: boolean) {
  return useQuery<GoalListRead>({
    queryKey: qk.goalsList(includeArchived),
    queryFn: () =>
      throwOnError(
        apiClient.GET('/goals', { params: { query: { include_archived: includeArchived } } }),
      ),
    // Toggling "show archived" is a different key: keep the current cards on
    // screen while the other variant loads instead of flashing the whole page
    // back to skeletons. First load still shows the skeletons.
    placeholderData: keepPreviousData,
  });
}

export function useCreateGoal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: GoalCreate) => throwOnError(apiClient.POST('/goals', { body })),
    onSuccess: () => {
      void invalidateAllGoals(queryClient);
    },
  });
}

export function useUpdateGoal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: GoalUpdate }) =>
      throwOnError(
        apiClient.PATCH('/goals/{goal_id}', { params: { path: { goal_id: id } }, body }),
      ),
    onSuccess: () => {
      void invalidateAllGoals(queryClient);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 404) {
        void invalidateAllGoals(queryClient);
      }
    },
  });
}

export function useDeleteGoal() {
  const queryClient = useQueryClient();
  return useMutation({
    // 204 No Content: openapi-fetch resolves `data: undefined`, which throwOnError
    // treats as failure — unwrap by hand (the transactions-delete precedent).
    mutationFn: async ({ id }: { id: string }) => {
      const { error, response } = await apiClient.DELETE('/goals/{goal_id}', {
        params: { path: { goal_id: id } },
      });
      if (!response.ok || error !== undefined) {
        throw new ApiError(response.status, error);
      }
    },
    onSuccess: () => {
      void invalidateAllGoals(queryClient);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 404) {
        void invalidateAllGoals(queryClient);
      }
    },
  });
}

/**
 * One goal's contribution ledger, newest first (server ORDER BY occurred_at desc).
 * Mounted by the card's expanded history section, so the query fires on expand
 * and nothing is fetched for a collapsed card.
 */
export function useContributions(goalId: string) {
  return useInfiniteQuery({
    queryKey: qk.goalContributions(goalId),
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      throwOnError(
        apiClient.GET('/goals/{goal_id}/contributions', {
          params: {
            path: { goal_id: goalId },
            query: { limit: CONTRIBUTIONS_PAGE_SIZE, offset: pageParam },
          },
        }),
      ),
    getNextPageParam: (_lastPage, pages) => {
      const loaded = pages.reduce((count, page) => count + page.items.length, 0);
      const total = pages[0]?.total ?? 0;
      return loaded < total ? loaded : undefined;
    },
  });
}

export function useAddContribution(goalId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ContributionCreate) =>
      throwOnError(
        apiClient.POST('/goals/{goal_id}/contributions', {
          params: { path: { goal_id: goalId } },
          body,
        }),
      ),
    onSuccess: () => {
      void invalidateGoalsList(queryClient);
      void invalidateGoal(queryClient, goalId);
    },
    onError: (error) => {
      // 404 = GOAL_NOT_FOUND (the goal is gone): drop the whole family.
      if (error instanceof ApiError && error.status === 404) {
        void invalidateAllGoals(queryClient);
      }
    },
  });
}

export function useDeleteContribution(goalId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ contributionId }: { contributionId: string }) => {
      const { error, response } = await apiClient.DELETE(
        '/goals/{goal_id}/contributions/{contribution_id}',
        { params: { path: { goal_id: goalId, contribution_id: contributionId } } },
      );
      if (!response.ok || error !== undefined) {
        throw new ApiError(response.status, error);
      }
    },
    onSuccess: () => {
      void invalidateGoalsList(queryClient);
      void invalidateGoal(queryClient, goalId);
    },
    onError: (error) => {
      // CONTRIBUTION_NOT_FOUND (someone else deleted it) — refetch this goal's
      // ledger so the stale row disappears behind the message.
      if (error instanceof ApiError && error.status === 404) {
        void invalidateGoal(queryClient, goalId);
      }
    },
  });
}

/**
 * The chart series, rendered VERBATIM (D12): the server emits one point per month
 * including empty months, with `saved_end_minor` already cumulative and including
 * the pre-window balance. The client never accumulates, gap-fills or clamps —
 * intermediate points CAN be negative (a past-dated withdrawal).
 */
export function useGoalProgress(goalId: string, months: number = PROGRESS_MONTHS) {
  return useQuery<ProgressPoint[]>({
    queryKey: qk.goalProgress(goalId, months),
    queryFn: () =>
      throwOnError(
        apiClient.GET('/goals/{goal_id}/progress', {
          params: { path: { goal_id: goalId }, query: { months } },
        }),
      ),
  });
}
