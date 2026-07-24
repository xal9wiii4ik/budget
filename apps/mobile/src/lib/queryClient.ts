// App-owned QueryClient (plan §D). Mobile-appropriate policy, mirroring web's
// per-query overrides but tuned for flaky mobile networks (O7):
//   - never retry 4xx: a 401 that reaches Query means refresh already failed, and
//     other 4xx are deterministic. Network errors carry NO ApiError, so they fall
//     through to the retry-transient arm and recover automatically.
//   - retry transient 5xx / network up to 2x.
//   - refetchOnReconnect is kept `true` but is INERT on React Native today: TanStack's
//     onlineManager has no reconnect signal here unless wired to NetInfo, and NetInfo
//     is a new native dep NOT approved in this task — nothing wires it, so this flag
//     never fires. Recovery today = the retry policy above + manual pull-to-refresh /
//     the per-screen Retry affordances. Wiring onlineManager.setEventListener to
//     @react-native-community/netinfo is a recorded FUTURE-TASK trigger; the moment it
//     lands, this flag becomes live with no other change here.
//   - refetchOnWindowFocus is a no-op on RN (kept explicit for parity).
// Offline is a state, not a crash: cached data renders while a refetch is in
// flight; no offline sync (deliberate post-MVP).
import { ApiError } from '@budget/api-client';
import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
          return false;
        }
        return failureCount < 2;
      },
    },
  },
});
