// Categories data layer (obligations C5). ONE archived-inclusive query is the
// single source for the picker (non-archived, client-filtered), the management
// screen (all), and the summary/list id joins. Mutations update THAT cache
// in-place by id from the returned CategoryRead — no single-row GET exists, and
// the summary/list joins read this cache reactively, so a rename/archive
// re-renders those screens without refetching transaction data.
import type { components } from '@budget/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiClient } from '../lib/api';
import { throwOnError } from '../lib/query';
import { qk } from './queryKeys';

type CategoryRead = components['schemas']['CategoryRead'];
type CategoryCreate = components['schemas']['CategoryCreate'];
type CategoryUpdate = components['schemas']['CategoryUpdate'];

export function useCategories() {
  return useQuery<CategoryRead[]>({
    queryKey: qk.categories(),
    queryFn: () =>
      throwOnError(
        apiClient.GET('/categories', {
          params: { query: { include_archived: true } },
        }),
      ),
    // Categories change rarely relative to transactions.
    staleTime: 60_000,
  });
}

export function useCreateCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CategoryCreate) =>
      throwOnError(apiClient.POST('/categories', { body })),
    onSuccess: (created) => {
      queryClient.setQueryData<CategoryRead[]>(qk.categories(), (prev) =>
        prev ? [...prev, created] : [created],
      );
    },
  });
}

export function useUpdateCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: CategoryUpdate }) =>
      throwOnError(
        apiClient.PATCH('/categories/{category_id}', {
          params: { path: { category_id: id } },
          body,
        }),
      ),
    onSuccess: (updated) => {
      queryClient.setQueryData<CategoryRead[]>(qk.categories(), (prev) =>
        prev ? prev.map((category) => (category.id === updated.id ? updated : category)) : prev,
      );
    },
  });
}
