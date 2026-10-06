// Web push data layer (web-push W1). One read and three writes (arch §6):
//
//   GET  /push/config         -> qk.pushConfig(), the ONLY cached entry
//   POST /push/subscriptions  -> 201, idempotent upsert by endpoint
//   POST /push/unsubscribe    -> 204 always (own row deleted, foreign untouched)
//   POST /push/test           -> {sent, removed}; 429 RATE_LIMITED
//
// The browser's subscription is BROWSER state — `pushManager.getSubscription()`
// is its source of truth — so it never enters the Query cache; nothing a write
// returns changes a cached read, hence no invalidation on success and no
// optimistic updates. The one exception is `PUSH_NOT_CONFIGURED` (503, keys
// removed from the server since the config was read): every write invalidates
// the bare ['push'] on it, and the refetched `enabled: false` flips the section
// to its server-off arm instead of showing an error the user cannot act on.
import { getErrorCode, type components } from '@budget/api-client';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { apiClient } from '../lib/api';
import { ApiError, throwOnError } from '../lib/query';
import { qk } from './queryKeys';

export type PushConfigRead = components['schemas']['PushConfigRead'];
export type PushSubscriptionCreate = components['schemas']['PushSubscriptionCreate'];
export type PushSubscriptionRead = components['schemas']['PushSubscriptionRead'];
export type PushUnsubscribe = components['schemas']['PushUnsubscribe'];
export type PushTestResult = components['schemas']['PushTestResult'];

function invalidateOnNotConfigured(queryClient: QueryClient) {
  return (error: unknown) => {
    if (error instanceof ApiError && getErrorCode(error.body) === 'PUSH_NOT_CONFIGURED') {
      void queryClient.invalidateQueries({ queryKey: ['push'] });
    }
  };
}

/**
 * Whether the server can push, and with which public key. `enabled` is false
 * until the owner sets the VAPID trio — the section explains that instead of
 * offering a button that would 503.
 */
export function usePushConfig({ enabled }: { enabled: boolean }) {
  return useQuery<PushConfigRead>({
    queryKey: qk.pushConfig(),
    queryFn: () => throwOnError(apiClient.GET('/push/config')),
    // Server configuration, read at API start: it cannot change within a
    // session without a restart (the `importFormats` precedent).
    staleTime: 60 * 60 * 1000,
    // The device-only arms (iOS tab, no push support) do not depend on it.
    enabled,
  });
}

export function useSubscribePush() {
  const queryClient = useQueryClient();
  return useMutation<PushSubscriptionRead, unknown, PushSubscriptionCreate>({
    mutationFn: (body) => throwOnError(apiClient.POST('/push/subscriptions', { body })),
    onError: invalidateOnNotConfigured(queryClient),
  });
}

export function useUnsubscribePush() {
  const queryClient = useQueryClient();
  return useMutation<void, unknown, PushUnsubscribe>({
    // 204 No Content: openapi-fetch resolves `data: undefined`, which
    // throwOnError treats as failure — unwrap by hand (`useRevokeToken`).
    mutationFn: async (body) => {
      const { error, response } = await apiClient.POST('/push/unsubscribe', { body });
      if (!response.ok || error !== undefined) {
        throw new ApiError(response.status, error);
      }
    },
    onError: invalidateOnNotConfigured(queryClient),
  });
}

export function useSendTestPush() {
  const queryClient = useQueryClient();
  return useMutation<PushTestResult, unknown, void>({
    mutationFn: () => throwOnError(apiClient.POST('/push/test')),
    onError: invalidateOnNotConfigured(queryClient),
  });
}
