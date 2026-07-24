import { QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useAuthListener } from '../src/auth/useAuthListener';
import { coordinator } from '../src/lib/api';
import { runDevProbes } from '../src/lib/probes';
import { queryClient } from '../src/lib/queryClient';

// Keep the native splash up until the coordinator's secure-store hydration resolves
// (O2) — the route guard reads the SYNCHRONOUS mirror, so it must not run before the
// mirror is populated.
void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    runDevProbes();
    coordinator.ready.finally(() => {
      setHydrated(true);
      void SplashScreen.hideAsync();
    });
  }, []);

  // Splash stays visible while null — the guard never evaluates a pre-hydration
  // snapshot.
  if (!hydrated) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <RootNavigator />
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function RootNavigator() {
  // Clears the Query cache on the signed-in -> signed-out edge.
  useAuthListener();

  return (
    <>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false }} />
    </>
  );
}
