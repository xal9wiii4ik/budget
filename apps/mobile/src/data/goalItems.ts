// Goal PLAN items — the tree of a goal (mobile-catchup-3, line C). A COPY of web's
// data/goalItems.ts; only the api/query import paths differ.
//
// Every number a node carries (`children_sum_minor`, `paid_minor`,
// `ceiling_exceeded`, `subtree_files_count`, `effective_deadline`, `depth`) is
// SERVER-COMPUTED by the recursive CTE. Nothing here — and nothing downstream —
// adds, converts or re-derives any of them, so every mutation ends in an
// invalidation and there are NO optimistic updates: a local guess would have to
// re-implement a whole-tree rollup to be right.
//
// Invalidation after any item write (create / PATCH / move / delete), copied
// verbatim from web:
//
//   ['goals', goalId]      the tree AND the goal detail (planned total, the three
//                          progress figures, has_items) — both live under it
//   ['goals','list']       the cards on the goals tab carry the same fields
//   ['goals','upcoming']   deadlines and reminders moved (the widget)
//
// DELETE additionally invalidates the transaction LISTS: the server sets
// `goal_item_id = NULL` on every operation attached to the removed subtree, so
// cached rows would keep claiming an attachment that no longer exists. It is the
// only place a goals write touches the transactions cache.
import type { components } from '@budget/api-client';
import { ApiError, throwOnError } from '@budget/api-client';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { apiClient } from '../lib/api';
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
 * (`children_sum_minor` / `paid_minor` are denominated in it, and AM-5 forbids
 * inferring that from anything else).
 *
 * The options are exported separately because two callers need the SAME cache
 * entry under different conditions: the plan screen mounts it eagerly, while the
 * transaction form's plan-item picker mounts it disabled until a goal is chosen.
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

export function useGoalItems(goalId: string, enabled: boolean = true) {
  // `enabled: false` is a screen that has no goal id to read (a malformed deep
  // link): no request, rather than a call to `/goals//items` that means nothing.
  return useQuery<GoalItemList>({ ...goalItemsQueryOptions(goalId), enabled });
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
 * sibling order — the client never computes a `sort_order`, so two devices
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
    // 204 No Content, unwrapped by hand (the goals-delete precedent).
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
      // The subtree's operations survive the delete, unattached — the rows in
      // every cached list still carry the old `goal_item_id`.
      void invalidateTxLists(queryClient);
    },
    onError: (error) => {
      // Already gone (another device): the row must still leave the screen.
      if (error instanceof ApiError && error.status === 404) invalidatePlan(queryClient, goalId);
    },
  });
}

// --- Attachments of a node -------------------------------------------------
//
// The receipts lifecycle minus the OCR, and the SAME three legs:
//
//   POST .../files                 -> row + presigned PUT   (api-client)
//   PUT  <presigned url>           -> the picked image      (RAW fetch, see
//                                     `uploadToPresigned` in data/receipts.ts —
//                                     one upload mechanism for the whole app)
//   POST .../files/{id}/confirm    -> the server HEADs the object and flips
//                                     `uploaded`; that flip is the ONLY thing
//                                     that can ever mint a `view_url`
//
// `view_url` exists ONLY on this list (and on the confirm response) and ONLY for
// an uploaded file: the tree deliberately carries counters, so a 500-node plan
// never mints hundreds of presigned URLs. It is short-lived (server-side GET
// presign TTL), which is why this query keeps a short staleTime instead of
// caching a URL past its life — reopening a node re-signs it.
//
// All three writes invalidate `['goals', goalId]`, the same prefix every other
// plan write uses: `files_count` / `subtree_files_count` are COUNT(*) over these
// rows, so a reservation (create) already moves the tree's numbers.
export type GoalItemFileRead = components['schemas']['GoalItemFileRead'];
export type GoalItemFileCreated = components['schemas']['GoalItemFileCreated'];

export function useGoalItemFiles(goalId: string, itemId: string, enabled: boolean) {
  return useQuery<GoalItemFileRead[]>({
    queryKey: qk.goalItemFiles(goalId, itemId),
    queryFn: () =>
      throwOnError(
        apiClient.GET('/goals/{goal_id}/items/{item_id}/files', {
          params: { path: { goal_id: goalId, item_id: itemId } },
        }),
      ),
    // Fetched WHEN A NODE IS OPENED — the counters on the tree row are what gate
    // this, exactly as they were designed to.
    enabled,
  });
}

export function useCreateGoalItemFile(goalId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId }: { itemId: string }): Promise<GoalItemFileCreated> =>
      throwOnError(
        apiClient.POST('/goals/{goal_id}/items/{item_id}/files', {
          params: { path: { goal_id: goalId, item_id: itemId } },
        }),
      ),
    onSuccess: () => invalidatePlan(queryClient, goalId),
    onError: (error) => {
      if (error instanceof ApiError && error.status === 404) invalidatePlan(queryClient, goalId);
    },
  });
}

export function useConfirmGoalItemFile(goalId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, fileId }: { itemId: string; fileId: string }): Promise<GoalItemFileRead> =>
      throwOnError(
        apiClient.POST('/goals/{goal_id}/items/{item_id}/files/{file_id}/confirm', {
          params: { path: { goal_id: goalId, item_id: itemId, file_id: fileId } },
        }),
      ),
    onSuccess: () => invalidatePlan(queryClient, goalId),
    onError: (error) => {
      if (error instanceof ApiError && error.status === 404) invalidatePlan(queryClient, goalId);
    },
  });
}

export function useDeleteGoalItemFile(goalId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    // 204 No Content, unwrapped by hand for the reason above the item delete.
    mutationFn: async ({ itemId, fileId }: { itemId: string; fileId: string }) => {
      const { error, response } = await apiClient.DELETE(
        '/goals/{goal_id}/items/{item_id}/files/{file_id}',
        { params: { path: { goal_id: goalId, item_id: itemId, file_id: fileId } } },
      );
      if (!response.ok || error !== undefined) {
        throw new ApiError(response.status, error);
      }
    },
    onSuccess: () => invalidatePlan(queryClient, goalId),
    onError: (error) => {
      // Already gone (another device, or a cleanup that raced us): the tile must
      // still leave the screen.
      if (error instanceof ApiError && error.status === 404) invalidatePlan(queryClient, goalId);
    },
  });
}
