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
      // WR-10 / P1. `navigator.onLine` is evidence about the BROWSER'S network
      // interface, not about our API (a localhost/LAN host in dev, one origin in
      // prod). Under the default 'online' mode a single `offline` window event —
      // DevTools throttling, a VPN or interface flap, a sleeping laptop — leaves
      // every query in `status: 'pending' / fetchStatus: 'paused'` until an
      // `online` event that may never come, and `isPending` is what every screen
      // renders a skeleton for: a silent, permanent, unexplained "loading"
      // (measured: paused at +0 ms, still pending after 12 s, promise never
      // settles). With 'always' the request is attempted, fails, retries inside
      // the SAME bounded budget below and lands in `error` (measured: ~3.0 s,
      // 3 attempts), where every screen already has an alert + Retry and every
      // form renders the network message. The retry policy above is unchanged.
      // Note `canContinue()` still requires focus, so a backgrounded tab pauses
      // between retries and resumes on return — correct, and left alone; that
      // residual paused window is what `queryPhase`'s 'unreachable' arm renders.
      networkMode: 'always',
    },
    mutations: {
      // Same argument as above: a mutation fired while the browser believes it is
      // offline must reach the error path (the describe*Error helpers already say
      // "Can't reach the server…") instead of hanging with the submit button
      // disabled and no explanation.
      networkMode: 'always',
    },
  },
});
