// The user profile (base currency, monthly income, country, language).
//
// The language the whole UI runs on lives HERE, on the server, because it is
// shared with the mobile client (architecture §5/§6). `language: null` means the
// user never chose one — it is not a third language, and resolving it is the
// client's job (i18n/I18nProvider).
//
// Types and transport are the generated client, like every other data module:
// `GET /profile` and `PATCH /profile` landed with this scope's backend line.
import type { components } from '@budget/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useIsAuthenticated } from '../auth/useAuth';
import { apiClient } from '../lib/api';
import { throwOnError } from '../lib/query';
import { qk } from './queryKeys';

export type ProfileRead = components['schemas']['ProfileRead'];
export type ProfileUpdate = components['schemas']['ProfileUpdate'];

/**
 * The profile, once, for the whole app. `['profile']` is a NEW top-level root,
 * disjoint from every shipped family, so no existing invalidation predicate
 * touches it — and a profile write invalidates ONLY this key: the server
 * localizes no payload, so a language change makes nothing else stale.
 *
 * Disabled while logged out (the `useMe` precedent): the login screen renders in
 * the locally cached / browser-detected language, with no request at all.
 */
export function useProfile() {
  const isAuthenticated = useIsAuthenticated();
  return useQuery<ProfileRead>({
    queryKey: qk.profile(),
    queryFn: () => throwOnError(apiClient.GET('/profile')),
    enabled: isAuthenticated,
    // Changes rarely, and the one screen that writes it invalidates explicitly.
    staleTime: 60_000,
  });
}

export function useUpdateProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ProfileUpdate) =>
      throwOnError(apiClient.PATCH('/profile', { body })),
    // The response IS the whole profile, so it seeds the cache directly; the
    // invalidate then reconciles with any concurrent writer (the mobile app).
    // No optimistic write: the language switch already applies instantly through
    // the provider's own choice state, so an optimistic cache lie would buy
    // nothing and would need a rollback path on failure.
    onSuccess: (updated) => {
      queryClient.setQueryData<ProfileRead>(qk.profile(), updated);
      void queryClient.invalidateQueries({ queryKey: qk.profile() });
    },
  });
}
