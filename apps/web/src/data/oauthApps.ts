// Connected AI apps (mcp-remote W1) — the grants issued through the remote MCP
// connector. One list read plus the revoke:
//
//   GET    /oauth/apps             -> ['oauth-apps','list']
//   DELETE /oauth/apps/{grant_id}  -> ['oauth-apps']   (also on a 404: it was
//                                     revoked in another tab or on the phone)
//
// Nothing else in the app reads a grant and no other mutation touches one. In
// particular this is NOT the tokens family: a grant and a personal access token
// are different rows, each 404s on the other's endpoint (server: `routers/tokens`
// filters `oauth_client_id IS NULL`), and the two Settings sections never show
// the same row twice.
//
// No optimistic updates: `revoked_at` is a server stamp.
import type { components } from '@budget/api-client';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { apiClient } from '../lib/api';
import { ApiError, throwOnError } from '../lib/query';
import { qk } from './queryKeys';

export type OAuthAppRead = components['schemas']['OAuthAppRead'];
export type OAuthAppList = components['schemas']['OAuthAppList'];

function invalidateConnectedApps(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: ['oauth-apps'] });
}

/**
 * Every app the user ever granted access to, revoked ones included — the server
 * sends them, because a revocation is a fact the screen shows rather than a row
 * to hide (the tokens precedent).
 */
export function useConnectedApps() {
  return useQuery<OAuthAppList>({
    queryKey: qk.oauthApps(),
    queryFn: () => throwOnError(apiClient.GET('/oauth/apps')),
  });
}

export function useRevokeConnectedApp() {
  const queryClient = useQueryClient();
  return useMutation({
    // 204 No Content: openapi-fetch resolves `data: undefined`, which
    // throwOnError treats as failure — unwrap by hand (`useRevokeToken`).
    mutationFn: async ({ id }: { id: string }) => {
      const { error, response } = await apiClient.DELETE('/oauth/apps/{grant_id}', {
        params: { path: { grant_id: id } },
      });
      if (!response.ok || error !== undefined) {
        throw new ApiError(response.status, error);
      }
    },
    onSuccess: () => {
      void invalidateConnectedApps(queryClient);
    },
    // OAUTH_APP_NOT_FOUND: already revoked (another tab, another device). Refetch
    // so the row picks up its real `revoked_at` behind the message.
    onError: (error) => {
      if (error instanceof ApiError && error.status === 404) {
        void invalidateConnectedApps(queryClient);
      }
    },
  });
}
