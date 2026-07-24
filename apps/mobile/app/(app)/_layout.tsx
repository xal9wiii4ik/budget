import { Redirect, Stack, usePathname } from 'expo-router';

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
  '/category-form': '/categories',
};

// The protected guard (O6). Gates on the SYNCHRONOUS coordinator snapshot (never the
// me-query — navigation must not block on a round-trip). When unauthenticated it
// redirects to /login preserving the intended route via the typed `next` param, plus
// `reason=expired` for a terminal refresh failure (not an intentional logout / cold
// start). The authFetch wrapper never navigates — this React guard reacts to the
// flipped snapshot. Modal form screens live INSIDE this group, behind the same guard.
export default function AppLayout() {
  const isAuthenticated = useIsAuthenticated();
  const pathname = usePathname();

  if (!isAuthenticated) {
    const next = MODAL_PARENT_TAB[pathname] ?? pathname;
    const params: Record<string, string> = { next };
    if (coordinator.wasSessionExpired()) params.reason = 'expired';
    return <Redirect href={{ pathname: '/login', params }} />;
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="transaction-form" options={{ presentation: 'modal' }} />
      <Stack.Screen name="category-form" options={{ presentation: 'modal' }} />
    </Stack>
  );
}
