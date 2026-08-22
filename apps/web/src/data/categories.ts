// Categories data layer (obligations C5). ONE archived-inclusive query is the
// single source for the picker (non-archived, client-filtered), the management
// screen (all), and the summary/list id joins. Mutations update THAT cache
// in-place by id from the returned CategoryRead — no single-row GET exists, and
// the summary/list joins read this cache reactively, so a rename/archive
// re-renders those screens without refetching transaction data.
import type { components } from '@budget/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { useLang } from '../i18n/context';
import { apiClient } from '../lib/api';
import { throwOnError } from '../lib/query';
import { localizeCategories } from './categoryLookup';
import { qk } from './queryKeys';

type CategoryRead = components['schemas']['CategoryRead'];
type CategoryCreate = components['schemas']['CategoryCreate'];
type CategoryUpdate = components['schemas']['CategoryUpdate'];

/**
 * S5: the CENTRAL point where system-category names become the user's language.
 * It is a `select`, not a transform at the call sites: the cache keeps the raw
 * server rows (so a mutation response and a translated view can never disagree),
 * every consumer of this hook gets translated names for free, and switching
 * language re-renders them without a refetch.
 */
export function useCategories() {
  const lang = useLang();
  const select = useCallback(
    (rows: CategoryRead[]) => localizeCategories(rows, lang),
    [lang],
  );
  return useQuery<CategoryRead[], Error, CategoryRead[]>({
    queryKey: qk.categories(),
    queryFn: () =>
      throwOnError(
        apiClient.GET('/categories', {
          params: { query: { include_archived: true } },
        }),
      ),
    select,
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
