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
 * PATCH /profile — the write behind the "More" tab (catch-up 3, line B): the
 * interface language, the base currency and the declared monthly income.
 *
 * The language one is also what makes a switch apply WITHOUT a restart: the
 * response seeds `['profile']` below, `useProfile` is what I18nProvider reads,
 * and the provider derives `lang` during render — so the whole tree re-renders in
 * the new language on the same tick the PATCH resolves.
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
        // The month SUMMARIES, which the server computes in the base currency.
        // Deliberately NOT invalidated: transaction LISTS (rows echo each
        // transaction's stored base snapshot — identical bytes, and a refetch
        // would re-request every loaded infinite page).
        void invalidateTxSummaries(queryClient);
        // --- recurring / settings (catch-up 3, line B) ---------------------
        // Mobile grew the settings screen that WRITES this field, and two more
        // families that are computed in the base currency: goals (line C) and
        // stats (line A). Both are invalidated at their BARE root, exactly like
        // web: every free-balance figure, every goal progress and every stats
        // aggregate is a server rollup in the base. The predicate is harmless
        // before those families exist — an invalidation of an unfetched key is
        // a no-op, not a request.
        void queryClient.invalidateQueries({ queryKey: ['goals'] });
        void queryClient.invalidateQueries({ queryKey: ['stats'] });
      } else if (previous?.monthly_income_minor !== updated.monthly_income_minor) {
        // The declared income feeds the goals screen's free-balance block (its
        // `declared` arm) and nothing else — so an income-only save refreshes
        // the goals LIST and leaves the rest of the cache alone.
        void queryClient.invalidateQueries({ queryKey: ['goals', 'list'] });
        // --- end recurring / settings (catch-up 3, line B) -----------------
      }
      // language / country only → ['profile'] alone.
    },
  });
}
