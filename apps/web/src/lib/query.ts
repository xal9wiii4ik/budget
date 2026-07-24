import { QueryClient } from '@tanstack/react-query';
import { ApiError } from '@budget/api-client';

// The result-unwrapping error carrier + helper now live in @budget/api-client
// (platform-free, shared with mobile). Re-exported here as VALUES so this module's
// existing importers keep importing `ApiError`/`throwOnError` from '../lib/query'
// unchanged (they do `new ApiError(...)` and `throwOnError(...)`).
export { ApiError, throwOnError } from '@budget/api-client';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The user object barely changes; calm refetch storms. 1.6 overrides
      // per-query where it needs fresher data.
      staleTime: 30_000,
      // A personal app — no surprise refetches on focus. 1.6 can opt in per-query.
      refetchOnWindowFocus: false,
      // Never retry 4xx: a 401 that survives to Query means refresh already
      // failed, and other 4xx are deterministic. Retry transient 5xx/network once.
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
          return false;
        }
        return failureCount < 2;
      },
    },
  },
});
