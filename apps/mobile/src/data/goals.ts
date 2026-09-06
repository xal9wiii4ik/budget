// Goals data layer (mobile-catchup-3, line C). A COPY of web's data/goals.ts —
// only the api/query import paths differ, and the progress SERIES is absent
// (there is no chart library on this client, deliberately).
//
// Everything the goals screen renders — the three progress figures, realism,
// months-to-target, the waterfall allocation, the free balance — is
// SERVER-COMPUTED. Nothing here recomputes any of it, so every mutation ends in
// an invalidation rather than a cache patch:
//
//   goal CRUD          -> ['goals']            (list + every per-goal family; a
//                                               delete/archive makes the per-goal
//                                               caches garbage anyway)
//   contribution write -> ['goals','list']     (saved/realism/waterfall move, and
//                                               a completing goal frees its share
//                                               for OTHER goals)
//                       + ['goals', goalId]    (that goal's ledger and detail)
//
// 404 onError refetches follow web's precedent: a row someone else deleted must
// disappear from the screen, and the caller still routes the message to the form
// via describeGoalError / describeContributionError.
import type { components } from '@budget/api-client';
import { ApiError, throwOnError } from '@budget/api-client';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';

import { apiClient } from '../lib/api';
import { qk } from './queryKeys';

export type GoalListRead = components['schemas']['GoalListRead'];
export type GoalRead = components['schemas']['GoalRead'];
type GoalCreate = components['schemas']['GoalCreate'];
type GoalUpdate = components['schemas']['GoalUpdate'];
type ContributionCreate = components['schemas']['ContributionCreate'];
export type ContributionRead = components['schemas']['ContributionRead'];

// The server caps `limit` at 200; one page covers any realistic ledger, and the
// envelope's `total` drives "load more" beyond that.
const CONTRIBUTIONS_PAGE_SIZE = 200;

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
    // screen while the other variant loads instead of flashing the whole tab
    // back to skeletons. First load still shows the skeletons.
    placeholderData: keepPreviousData,
  });
}

/**
 * ONE goal, read from `GET /goals/{goal_id}`.
 *
 * The plan screen mounts this rather than picking the goal out of a cached list:
 * a deep link has no list in cache, and the single GET runs the same assembler as
 * the list, so every plan field (`has_items`, `effective_target_minor`, the three
 * progress figures) is present and identical.
 *
 * A 404 is a real state of that screen ("the goal is gone"), so it is not retried
 * into an eternal spinner and the caller renders its own arm for it.
 */
export function useGoal(goalId: string, enabled: boolean = true) {
  return useQuery<GoalRead>({
    queryKey: qk.goalDetail(goalId),
    queryFn: () =>
      throwOnError(apiClient.GET('/goals/{goal_id}', { params: { path: { goal_id: goalId } } })),
    // `false` is the goal form's CREATE mode: no id to read, so no request — an
    // empty path parameter would be a call to `/goals/` that means nothing.
    enabled,
    // A 4xx is an answer, not a flake: retrying it would only delay the screen's
    // own "this goal is gone" arm. (Web gets this from lib/query's global
    // retry rule; mobile's client has no such wrapper, so it is stated here.)
    retry: (failureCount, error) =>
      error instanceof ApiError && error.status < 500 ? false : failureCount < 2,
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
 * Mounted by the plan screen's "saved" tab, so nothing is fetched while the user
 * is looking at the tree.
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
      // CONTRIBUTION_NOT_FOUND (deleted elsewhere) — refetch this goal's ledger so
      // the stale row disappears behind the message.
      if (error instanceof ApiError && error.status === 404) {
        void invalidateGoal(queryClient, goalId);
      }
    },
  });
}
