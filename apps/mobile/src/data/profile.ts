// The user profile (base currency, monthly income, country, language).
//
// The language the whole UI runs on lives HERE, on the server, because it is
// shared with the web client: a language picked in web settings is what this app
// then renders in. `language: null` means the user never chose one — it is not a
// third language, and resolving it is the client's job (i18n/I18nProvider).
//
// Copied from web data/profile.ts; the deltas are listed on `useUpdateProfile`.
import type { components } from '@budget/api-client';
import { throwOnError } from '@budget/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useIsAuthenticated } from '../auth/useAuth';
import { apiClient } from '../lib/api';
import { qk } from './queryKeys';
import { invalidateTxSummaries } from './transactions';

export type ProfileRead = components['schemas']['ProfileRead'];
export type ProfileUpdate = components['schemas']['ProfileUpdate'];

/**
 * The profile, once, for the whole app. `['profile']` is a NEW top-level root,
 * disjoint from every shipped family, so no existing invalidation predicate
 * touches it.
 *
 * Disabled while logged out (the `useMe` precedent): the login screen renders in
 * the DEVICE language, with no request at all.
 */
export function useProfile() {
  const isAuthenticated = useIsAuthenticated();
  return useQuery<ProfileRead>({
    queryKey: qk.profile(),
    queryFn: () => throwOnError(apiClient.GET('/profile')),
    enabled: isAuthenticated,
    // Changes rarely, and whoever writes it invalidates explicitly.
    staleTime: 60_000,
  });
}

/**
 * PATCH /profile. Mobile has no settings screen yet (the language and the base
 * currency are chosen on the web client), so nothing calls this today — it is
 * kept in parity with web so the first mobile settings screen inherits the
 * cache rules instead of reinventing them.
 */
export function useUpdateProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ProfileUpdate) =>
      throwOnError(apiClient.PATCH('/profile', { body })),
    // The response IS the whole profile, so it seeds the cache directly; the
    // invalidate then reconciles with any concurrent writer (the web app). No
    // optimistic write: an optimistic cache lie would need a rollback path on
    // failure and buys nothing here.
    //
    // The extra invalidation is PER FIELD, and the trigger is the CACHED profile
    // compared against the PATCH RESPONSE — not the body we sent. The response is
    // the only thing that sees a server-side effect (a base switch CLEARS
    // `monthly_income_minor` in the same transaction) or a field the web client
    // changed since this cache was seeded, and it never fires on a same-value
    // PATCH. With no cached profile the comparison FAILS OPEN
    // (`undefined !== 'RUB'`), which is the safe direction.
    onSuccess: (updated) => {
      const previous = queryClient.getQueryData<ProfileRead>(qk.profile());
      queryClient.setQueryData<ProfileRead>(qk.profile(), updated);
      void queryClient.invalidateQueries({ queryKey: qk.profile() });

      if (previous?.base_currency !== updated.base_currency) {
        // Trimmed to what mobile actually caches: the month SUMMARIES, which the
        // server computes in the base currency. Web also invalidates ['goals'],
        // ['stats'] and ['limits'] — none of those families exist on mobile.
        // Deliberately NOT invalidated here either: transaction LISTS (rows echo
        // each transaction's stored base snapshot — identical bytes, and a
        // refetch would re-request every loaded infinite page).
        void invalidateTxSummaries(queryClient);
      }
      // language / country / income only → ['profile'] alone. (Mobile caches
      // nothing derived from the declared income — web's ['goals','list'] arm
      // has no counterpart here.)
    },
  });
}
