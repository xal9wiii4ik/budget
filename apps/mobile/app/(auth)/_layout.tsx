import { Redirect, Stack, useLocalSearchParams, type Href } from 'expo-router';

import { safeNextRoute } from '../../src/auth/next';
import { useIsAuthenticated } from '../../src/auth/useAuth';
import { useNavigationChrome } from '../../src/theme/navigation';

// Auth stack. An already-authenticated visitor never sees login/register — bounce out
// of the unauthenticated stack.
//
// The bounce target must honor `next`, not hardcode /transactions (defect TC-8). On a
// successful sign-in two navigations race: the login screen's own
// `router.replace(safeNextRoute(next))` and this layout's <Redirect>, which expo-router
// re-issues as a replace on every render of the still-mounted auth stack once the auth
// snapshot flips. Whichever lands last wins, and a hardcoded /transactions here would
// (often) overwrite the deep-linked target the user was sent to log in for. Resolving
// the SAME `next` through the SAME validator makes both replaces converge on one target,
// so the race becomes harmless instead of order-dependent. safeNextRoute already falls
// back to the default authed route for a missing/foreign value — no extra default here.
//
// gestureEnabled:false disables iOS swipe-back so a user can't swipe out of the
// unauthenticated stack into nothing (O6 / plan Platform concerns).
//
// This stack hides the header, so `contentStyle` is the ONLY thing standing
// between a dark theme and the navigator's own white page behind login/register
// (the screens' SafeAreaView paints the background, but the frame around it does
// not) — the same option the (app) group sets, from the same chrome object.
export default function AuthLayout() {
  const isAuthenticated = useIsAuthenticated();
  const params = useLocalSearchParams<{ next?: string }>();
  const chrome = useNavigationChrome();

  if (isAuthenticated) {
    return <Redirect href={safeNextRoute(params.next) as Href} />;
  }

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        gestureEnabled: false,
        contentStyle: chrome.stack.contentStyle,
      }}
    />
  );
}
