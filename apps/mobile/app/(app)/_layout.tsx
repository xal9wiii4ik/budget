import { Redirect, Stack, usePathname, useRootNavigationState } from 'expo-router';
import { useEffect } from 'react';

import { captureIntendedRoute, releaseIntendedRoute } from '../../src/auth/intendedRoute';
import { useIsAuthenticated } from '../../src/auth/useAuth';
import { coordinator } from '../../src/lib/api';

// Modal form routes carry their target in query params (`?id=…`) that usePathname()
// drops, and there is NO `GET /transactions/{id}` or `GET /categories/{id}` to refetch
// an edit target — so after re-login the Query cache is cold and the edit context is
// unrecoverable. Encoding the bare modal path as `next` would silently reopen an edit
// modal in CREATE mode (id absent), inviting a duplicate entry. So we map each modal to
// its PARENT TAB instead: that closes the silent-mode-switch hazard honestly rather
// than pretending the edit is recoverable. Tab routes carry no params (month is local
// state), so their pathname is preserved as-is.
const MODAL_PARENT_TAB: Record<string, string> = {
  '/transaction-form': '/transactions',
  '/transfer-form': '/transactions',
  '/category-form': '/categories',
  '/account-form': '/accounts',
};

// This layout's own route group — the intended route is by definition inside it.
const APP_GROUP_SEGMENT = '(app)';

// The protected guard (O6). Gates on the SYNCHRONOUS coordinator snapshot (never the
// me-query — navigation must not block on a round-trip). When unauthenticated it
// redirects to /login preserving the intended route via the typed `next` param, plus
// `reason=expired` for a terminal refresh failure (not an intentional logout / cold
// start). The authFetch wrapper never navigates — this React guard reacts to the
// flipped snapshot. Modal form screens live INSIDE this group, behind the same guard.
//
// The intended route is resolved from the LIVE root navigation state rather than
// usePathname(), because on a COLD deep link into this group the router store has not
// been written yet and usePathname() still reads `/` — which the index route turns
// into /transactions, i.e. defect TC-8. usePathname() remains the last-resort fallback
// for states the walk cannot resolve at all. See src/auth/intendedRoute.ts for which
// part of the navigation state is authoritative per arm, and for why the answer is
// remembered across the redirect's re-renders.
export default function AppLayout() {
  const isAuthenticated = useIsAuthenticated();
  const rootState = useRootNavigationState();
  const pathname = usePathname();

  useEffect(() => {
    if (isAuthenticated) releaseIntendedRoute();
  }, [isAuthenticated]);

  if (!isAuthenticated) {
    const intended = captureIntendedRoute(rootState, APP_GROUP_SEGMENT) ?? pathname;
    const next = MODAL_PARENT_TAB[intended] ?? intended;
    const params: Record<string, string> = { next };
    if (coordinator.wasSessionExpired()) params.reason = 'expired';
    return <Redirect href={{ pathname: '/login', params }} />;
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="transaction-form" options={{ presentation: 'modal' }} />
      <Stack.Screen name="transfer-form" options={{ presentation: 'modal' }} />
      <Stack.Screen name="category-form" options={{ presentation: 'modal' }} />
      <Stack.Screen name="account-form" options={{ presentation: 'modal' }} />
    </Stack>
  );
}
