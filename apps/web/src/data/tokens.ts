// Personal access tokens data layer (mcp-server S2). One list read plus the two
// writes; the list is the whole management surface (there is no per-token GET —
// `/tokens/self` answers a TOKEN about itself and 404s for a browser session).
//
// Invalidation matrix:
//
//   POST /tokens        -> ['tokens']
//   DELETE /tokens/{id} -> ['tokens']   (also on a 404: it was revoked elsewhere)
//
// Nothing else in the app reads token rows, and no other mutation touches them.
//
// THE PLAINTEXT NEVER ENTERS THE CACHE. `useCreateToken` returns the whole
// `TokenCreated` (plaintext included) to its caller and writes nothing with
// `setQueryData`: the string exists once, in the creating component's state, and
// dies with it. Caching it would put an authentication secret into a store that
// outlives the modal and is trivially inspectable from devtools — and the
// invalidated list refetch brings back the same row WITHOUT the token field,
// which is the shape every other reader should see.
//
// No optimistic updates: both writes are rare, and an optimistic revoke would
// have to invent the `revoked_at` timestamp that only the server can stamp.
import type { components } from '@budget/api-client';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { apiClient } from '../lib/api';
import { ApiError, throwOnError } from '../lib/query';
import { qk } from './queryKeys';

export type TokenRead = components['schemas']['TokenRead'];
export type TokenCreated = components['schemas']['TokenCreated'];
export type TokenCreate = components['schemas']['TokenCreate'];
export type PatScope = components['schemas']['PatScope'];

function invalidateTokens(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: ['tokens'] });
}

/**
 * Every token the user owns, revoked ones included — the server sends them
 * (`created_at desc, id`) because a revocation is a fact the screen shows, not a
 * row to hide.
 */
export function useTokens() {
  return useQuery<components['schemas']['TokenList']>({
    queryKey: qk.tokens(),
    queryFn: () => throwOnError(apiClient.GET('/tokens')),
  });
}

/**
 * Issue a token. The response carries the ONLY copy of the plaintext that will
 * ever exist — it is returned to the caller and deliberately not cached (see the
 * module note above).
 */
export function useCreateToken() {
  const queryClient = useQueryClient();
  return useMutation<TokenCreated, unknown, TokenCreate>({
    mutationFn: (body: TokenCreate) => throwOnError(apiClient.POST('/tokens', { body })),
    onSuccess: () => {
      void invalidateTokens(queryClient);
    },
  });
}

export function useRevokeToken() {
  const queryClient = useQueryClient();
  return useMutation({
    // 204 No Content: openapi-fetch resolves `data: undefined`, which throwOnError
    // treats as failure — unwrap by hand (the shipped delete precedent).
    mutationFn: async ({ id }: { id: string }) => {
      const { error, response } = await apiClient.DELETE('/tokens/{token_id}', {
        params: { path: { token_id: id } },
      });
      if (!response.ok || error !== undefined) {
        throw new ApiError(response.status, error);
      }
    },
    onSuccess: () => {
      void invalidateTokens(queryClient);
    },
    // TOKEN_NOT_FOUND: already revoked (another tab, another device). Refetch so
    // the row picks up its real `revoked_at` behind the message (T6/T9 precedent).
    onError: (error) => {
      if (error instanceof ApiError && error.status === 404) {
        void invalidateTokens(queryClient);
      }
    },
  });
}
