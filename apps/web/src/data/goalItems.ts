// Goal PLAN items — the tree of a goal (goal-planner W1).
//
// Every number a node carries (`children_sum_minor`, `paid_minor`,
// `ceiling_exceeded`, `subtree_files_count`, `effective_deadline`, `depth`) is
// SERVER-COMPUTED by the recursive CTE (architecture §4). Nothing here — and
// nothing downstream — adds, converts or re-derives any of them, so every
// mutation ends in an invalidation and there are NO optimistic updates: a local
// guess would have to re-implement a whole-tree rollup to be right.
//
// Invalidation after any item write (create / PATCH / move / delete):
//
//   ['goals', goalId]      the tree AND the goal detail (planned total, the three
//                          progress figures, has_items) — both live under it
//   ['goals','list']       the cards on /goals carry the same computed fields
//   ['goals','upcoming']   deadlines and reminders moved (the widget lands in W2;
//                          invalidating a family with no entries is a no-op, and
//                          declaring it here keeps the rule in ONE place)
//
// DELETE additionally invalidates the transaction LISTS: the server sets
// `goal_item_id = NULL` on every operation attached to the removed subtree
// (architecture §3), so cached rows would keep claiming an attachment that no
// longer exists. It is the only place a goals write touches the transactions
// cache.
import type { components } from '@budget/api-client';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { apiClient } from '../lib/api';
import { ApiError, throwOnError } from '../lib/query';
import { qk } from './queryKeys';
import { invalidateTxLists } from './transactions';

export type GoalItemRead = components['schemas']['GoalItemRead'];
export type GoalItemList = components['schemas']['GoalItemList'];
export type GoalItemCreate = components['schemas']['GoalItemCreate'];
export type GoalItemUpdate = components['schemas']['GoalItemUpdate'];

function invalidatePlan(queryClient: QueryClient, goalId: string): void {
  void queryClient.invalidateQueries({ queryKey: ['goals', goalId] });
  void queryClient.invalidateQueries({ queryKey: ['goals', 'list'] });
  void queryClient.invalidateQueries({ queryKey: ['goals', 'upcoming'] });
}

/**
 * The whole tree of one goal: a FLAT list plus the goal's currency echoed once
 * (Q2 — `children_sum_minor` / `paid_minor` are denominated in it, and AM-5
 * forbids inferring that from anything else).
 *
 * The options are exported separately (W2) because two callers need the SAME
 * cache entry under different conditions: the plan screen mounts it eagerly,
 * while the transaction form's attach picker mounts it disabled until a goal is
 * chosen, and its "which goal owns this item" fan-out mounts several at once
 * through `useQueries`. One definition of key + fetcher keeps those three from
 * drifting into three cache entries for one tree.
 */
export function goalItemsQueryOptions(goalId: string) {
  return {
    queryKey: qk.goalItems(goalId),
    queryFn: (): Promise<GoalItemList> =>
      throwOnError(
        apiClient.GET('/goals/{goal_id}/items', { params: { path: { goal_id: goalId } } }),
      ),
  };
}

export function useGoalItems(goalId: string) {
  return useQuery<GoalItemList>(goalItemsQueryOptions(goalId));
}

export function useCreateGoalItem(goalId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: GoalItemCreate) =>
      throwOnError(
        apiClient.POST('/goals/{goal_id}/items', {
          params: { path: { goal_id: goalId } },
          body,
        }),
      ),
    onSuccess: () => invalidatePlan(queryClient, goalId),
    onError: (error) => {
      // GOAL_NOT_FOUND / GOAL_ITEM_PARENT_NOT_FOUND: the screen is describing a
      // tree that has changed under it — refetch so the message is not the only
      // sign of it.
      if (error instanceof ApiError && error.status === 404) invalidatePlan(queryClient, goalId);
    },
  });
}

/**
 * One PATCH covers every edit of a node: its fields, its parent (`parent_id`) and
 * its position among siblings (`move: 'up' | 'down'`).
 *
 * `move` is a RELATIVE instruction resolved by the server against the current
 * sibling order (PM Q3) — the client never computes a `sort_order`, so two people
 * pressing "up" cannot interleave into an order neither asked for.
 */
export function useUpdateGoalItem(goalId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, body }: { itemId: string; body: GoalItemUpdate }) =>
      throwOnError(
        apiClient.PATCH('/goals/{goal_id}/items/{item_id}', {
          params: { path: { goal_id: goalId, item_id: itemId } },
          body,
        }),
      ),
    onSuccess: () => invalidatePlan(queryClient, goalId),
    onError: (error) => {
      if (error instanceof ApiError && error.status === 404) invalidatePlan(queryClient, goalId);
    },
  });
}

export function useDeleteGoalItem(goalId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    // 204 No Content: openapi-fetch resolves `data: undefined`, which throwOnError
    // treats as failure — unwrapped by hand (the goals/limits precedent).
    mutationFn: async ({ itemId }: { itemId: string }) => {
      const { error, response } = await apiClient.DELETE('/goals/{goal_id}/items/{item_id}', {
        params: { path: { goal_id: goalId, item_id: itemId } },
      });
      if (!response.ok || error !== undefined) {
        throw new ApiError(response.status, error);
      }
    },
    onSuccess: () => {
      invalidatePlan(queryClient, goalId);
      // The subtree's operations survive the delete, unattached (§3) — the rows
      // in every cached list still carry the old `goal_item_id`.
      void invalidateTxLists(queryClient);
    },
    onError: (error) => {
      // Already gone (another tab): the row must still leave the screen.
      if (error instanceof ApiError && error.status === 404) invalidatePlan(queryClient, goalId);
    },
  });
}
