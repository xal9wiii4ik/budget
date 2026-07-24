import { useEffect, useRef } from 'react';

import { queryClient } from '../lib/query';
import { useIsAuthenticated } from './useAuth';

/**
 * Clears the Query cache when auth transitions from signed-in to signed-out
 * (logout or terminal refresh failure), so a stale user object never leaks into
 * a fresh session. This is a genuine external effect (cache mutation on an auth
 * transition), not server-state syncing.
 */
export function useAuthListener(): void {
  const isAuthenticated = useIsAuthenticated();
  const wasAuthenticated = useRef(isAuthenticated);

  useEffect(() => {
    if (wasAuthenticated.current && !isAuthenticated) {
      queryClient.clear();
    }
    wasAuthenticated.current = isAuthenticated;
  }, [isAuthenticated]);
}
