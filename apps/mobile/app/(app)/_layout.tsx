import { Redirect, Stack, usePathname, useRootNavigationState } from 'expo-router';
import { useEffect, useState } from 'react';

import { captureIntendedRoute, releaseIntendedRoute } from '../../src/auth/intendedRoute';
import { useIsAuthenticated } from '../../src/auth/useAuth';
import { coordinator } from '../../src/lib/api';
import { useNavigationChrome } from '../../src/theme/navigation';

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
  // catch-up 3 line A: `/category-transactions?id=` is not a modal, but it is in
  // this table for exactly the same reason as the forms — its id is unrecoverable
  // after re-login (`usePathname()` drops the query, and the screen without an id
  // has nothing to show), so it resolves to the tab it was opened from.
  '/category-transactions': '/categories',
  // --- recurring / settings (catch-up 3, line B) ------------------------------
  // The template form is the same case as the forms above (an `?id=` that a
  // pathname drops), but its parent is NOT a tab: `/recurring` is a stable pushed
  // route with no params of its own, so it is a perfectly good `next` — it
  // re-reads its own list on mount and the user lands where they were heading.
  '/recurring-form': '/recurring',
  // --- end recurring / settings (catch-up 3, line B) --------------------------
  // --- goals (catch-up 3, line C) ---------------------------------------------
  // Every goals modal carries its subject in an `?id=` that `usePathname()`
  // drops, so re-login resolves them to the tab they belong to rather than
  // reopening a form with no id (which would silently be a CREATE form). The
  // plan screen itself is NOT in this table on purpose: it is pushed, its id is
  // its whole content, and the goals tab is where the user picks a goal again —
  // which is exactly what these entries say.
  '/goal-form': '/goals',
  '/goal-plan': '/goals',
  '/goal-cost-form': '/goals',
  '/goal-item-form': '/goals',
  '/contribution-form': '/goals',
  // --- end goals (catch-up 3, line C) -----------------------------------------
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

  // O-1: one MOUNT of this guard is one intended-route EPISODE, and the capture below
  // keeps the first answer of an episode (src/auth/intendedRoute.ts explains why the
  // LAST render of a redirect resolves a stale route). This token is the episode's
  // identity — a fresh object per mount, which is exactly what "a new navigation into
  // this group" means. A `useState` initializer rather than a ref because the value is
  // read DURING render, where the capture happens.
  const [episode] = useState<object>(() => ({}));
  // Above the guard's early return: hooks are unconditional.
  const { stack } = useNavigationChrome();

  useEffect(() => {
    if (isAuthenticated) releaseIntendedRoute();
  }, [isAuthenticated]);

  if (!isAuthenticated) {
    const intended = captureIntendedRoute(rootState, APP_GROUP_SEGMENT, episode) ?? pathname;
    const next = MODAL_PARENT_TAB[intended] ?? intended;
    const params: Record<string, string> = { next };
    if (coordinator.wasSessionExpired()) params.reason = 'expired';
    return <Redirect href={{ pathname: '/login', params }} />;
  }

  return (
    // The group hides the native header (three pushed screens re-enable it
    // locally and inherit the themed one, since per-screen options merge OVER
    // screenOptions); `contentStyle` is what keeps a screen's background out of
    // the platform's white.
    <Stack screenOptions={{ headerShown: false, ...stack }}>
      {/* R4: a modal is presented in its OWN container, which does NOT inherit
          the group's contentStyle — without this each of the nine form screens
          flashes (and then stays) white behind a dark form. */}
      <Stack.Screen name="(tabs)" />
      <Stack.Screen
        name="transaction-form"
        options={{ presentation: 'modal', contentStyle: stack.contentStyle }}
      />
      <Stack.Screen
        name="transfer-form"
        options={{ presentation: 'modal', contentStyle: stack.contentStyle }}
      />
      <Stack.Screen
        name="category-form"
        options={{ presentation: 'modal', contentStyle: stack.contentStyle }}
      />
      <Stack.Screen
        name="account-form"
        options={{ presentation: 'modal', contentStyle: stack.contentStyle }}
      />
      {/* catch-up 3 line A: PUSHED, not a modal — a place you navigate to and read,
          so it keeps the platform's own back gesture and its own header (whose title
          the screen sets to the category's name). */}
      <Stack.Screen name="category-transactions" />
      {/* --- recurring / settings (catch-up 3, line B) ---
          `recurring` is PUSHED (off the More tab) so it keeps the platform back
          gesture and a native header; the template form is a modal like every
          other form screen. */}
      <Stack.Screen name="recurring" />
      <Stack.Screen
        name="recurring-form"
        options={{ presentation: 'modal', contentStyle: stack.contentStyle }}
      />
      {/* --- goals (catch-up 3, line C) ---
          The plan screen is PUSHED (off a goal card): it is a destination you
          read and work in, so it keeps the platform back gesture. Everything
          else here is a form, hence a modal, like every other form screen. */}
      <Stack.Screen name="goal-plan" />
      <Stack.Screen
        name="goal-form"
        options={{ presentation: 'modal', contentStyle: stack.contentStyle }}
      />
      <Stack.Screen
        name="goal-cost-form"
        options={{ presentation: 'modal', contentStyle: stack.contentStyle }}
      />
      <Stack.Screen
        name="goal-item-form"
        options={{ presentation: 'modal', contentStyle: stack.contentStyle }}
      />
      <Stack.Screen
        name="contribution-form"
        options={{ presentation: 'modal', contentStyle: stack.contentStyle }}
      />
    </Stack>
  );
}
