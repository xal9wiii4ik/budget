import { throwOnError } from '@budget/api-client';
import type { UserRead } from '@budget/api-client';
import { useQuery } from '@tanstack/react-query';

import { apiClient } from '../lib/api';
import { meQueryKey } from './meQueryKey';
import { useIsAuthenticated } from './useAuth';

/**
 * The authenticated user object (server state -> TanStack Query, never Zustand).
 * Disabled while logged out so it never fires without a token; re-enables the
 * moment the coordinator snapshot flips to authenticated.
 */
export function useMe() {
  const isAuthenticated = useIsAuthenticated();
  return useQuery<UserRead>({
    queryKey: meQueryKey,
    queryFn: () => throwOnError(apiClient.GET('/users/me')),
    enabled: isAuthenticated,
  });
}
