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
import { invalidateTxSummaries } from './transactions';

export type ProfileRead = components['schemas']['ProfileRead'];
export type ProfileUpdate = components['schemas']['ProfileUpdate'];

/**
 * The profile, once, for the whole app. `['profile']` is a NEW top-level root,
 * disjoint from every shipped family, so no existing invalidation predicate
 * touches it. A LANGUAGE write still invalidates only this key (the server
 * localizes no payload), but a BASE-CURRENCY write does not — see
 * `useUpdateProfile` below.
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
    //
    // D3 (base-currency-and-goal-basis): the extra invalidation is PER FIELD, and
    // the trigger is the CACHED profile compared against the PATCH RESPONSE — not
    // the body we sent. The response is the only thing that sees a server-side
    // effect (a base switch CLEARS `monthly_income_minor` in the same
    // transaction) or a field another tab changed since this cache was seeded,
    // and it never fires on a same-value PATCH. With no cached profile the
    // comparison FAILS OPEN (`undefined !== 'RUB'`), which is the safe direction.
    onSuccess: (updated) => {
      const previous = queryClient.getQueryData<ProfileRead>(qk.profile());
      queryClient.setQueryData<ProfileRead>(qk.profile(), updated);
      void queryClient.invalidateQueries({ queryKey: qk.profile() });

      const baseChanged = previous?.base_currency !== updated.base_currency;
      const incomeChanged =
        previous?.monthly_income_minor !== updated.monthly_income_minor;

      if (baseChanged) {
        // Everything the server computes IN the base currency (evidence table:
        // .tasks/base-currency-and-goal-basis/plan-web.md §5).
        void queryClient.invalidateQueries({ queryKey: ['goals'] });
        void queryClient.invalidateQueries({ queryKey: ['stats'] });
        void queryClient.invalidateQueries({ queryKey: ['limits'] });
        void invalidateTxSummaries(queryClient);
        // Deliberately NOT invalidated: transaction LISTS (rows echo each
        // transaction's stored base snapshot — identical bytes, and a refetch
        // would re-request every loaded infinite page) and ['fx','convert', …]
        // (every input incl. `to` is in the key, so the new base is a new entry
        // by construction, never a stale one).
      } else if (incomeChanged) {
        // The declared income is the free balance itself when the basis is
        // "declared", so a goals screen open in another tab is stale the moment
        // it is saved. Nothing else on a cached path reads it (the advisor reads
        // it per request over SSE, which has no Query cache). Only reached when
        // the base did NOT change: the branch above already invalidates the bare
        // ['goals'] prefix, of which ['goals','list'] is a subset.
        void queryClient.invalidateQueries({ queryKey: ['goals', 'list'] });
      }
      // language / country only → ['profile'] alone, exactly as before.
    },
  });
}
