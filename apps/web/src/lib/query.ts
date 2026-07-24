import { QueryClient } from '@tanstack/react-query';

/**
 * Error thrown by `throwOnError` when an openapi-fetch call resolves to a non-2xx
 * response. openapi-fetch does NOT throw on HTTP errors (it returns
 * `{ data, error, response }`), so query/mutation functions funnel through
 * `throwOnError` to give TanStack Query a real thrown error carrying the status
 * and the parsed error body (for `getErrorCode`).
 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(`API request failed with status ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

type FetchResult<T> = {
  data?: T;
  error?: unknown;
  response: Response;
};

/**
 * Unwrap an openapi-fetch result: return `data` on success, else throw an
 * `ApiError` carrying the status + parsed error body.
 */
export async function throwOnError<T>(promise: Promise<FetchResult<T>>): Promise<T> {
  const { data, error, response } = await promise;
  if (!response.ok || error !== undefined || data === undefined) {
    throw new ApiError(response.status, error);
  }
  return data;
}

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
