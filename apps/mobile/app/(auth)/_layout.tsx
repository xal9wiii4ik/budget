import { Redirect, Stack } from 'expo-router';

import { useIsAuthenticated } from '../../src/auth/useAuth';

// Auth stack. An already-authenticated visitor never sees login/register — bounce to
// the default authed route (the login screen still honors `next` on a fresh sign-in).
// gestureEnabled:false disables iOS swipe-back so a user can't swipe out of the
// unauthenticated stack into nothing (O6 / plan Platform concerns).
export default function AuthLayout() {
  const isAuthenticated = useIsAuthenticated();

  if (isAuthenticated) {
    return <Redirect href="/transactions" />;
  }

  return <Stack screenOptions={{ headerShown: false, gestureEnabled: false }} />;
}
