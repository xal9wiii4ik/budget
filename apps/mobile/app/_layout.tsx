import { QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useAuthListener } from '../src/auth/useAuthListener';
import { I18nProvider } from '../src/i18n/I18nProvider';
import { coordinator } from '../src/lib/api';
import { runDevProbes } from '../src/lib/probes';
import { queryClient } from '../src/lib/queryClient';
import { loadFonts } from '../src/theme/fonts';
import { useNavigationChrome } from '../src/theme/navigation';
import { readPreference } from '../src/theme/preferenceStorage';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import type { ThemePreference } from '../src/theme/themeStore';
import { useTheme } from '../src/theme/useTheme';

// Keep the native splash up until the coordinator's secure-store hydration resolves
// (O2) — the route guard reads the SYNCHRONOUS mirror, so it must not run before the
// mirror is populated.
void SplashScreen.preventAutoHideAsync();

// Everything the FIRST FRAME needs, resolved behind the one splash gate.
interface Boot {
  preference: ThemePreference;
  fontsLoaded: boolean;
}

export default function RootLayout() {
  const [boot, setBoot] = useState<Boot | null>(null);

  useEffect(() => {
    runDevProbes();
    // The theme preference and Inter join the coordinator's hydration in ONE
    // Promise.all (mobile-design decision 2/3): a first frame in the light theme
    // or in the system font is a visible flash, and both answers are cheap local
    // reads. Neither theme call rejects by construction; `ready` is caught
    // rather than awaited bare so a hydration failure still lifts the splash,
    // exactly as the old `.finally()` did.
    void Promise.all([coordinator.ready.catch(() => undefined), readPreference(), loadFonts()])
      .then(([, preference, fontsLoaded]) => setBoot({ preference, fontsLoaded }))
      .catch(() => setBoot({ preference: 'system', fontsLoaded: false }))
      .finally(() => {
        void SplashScreen.hideAsync();
      });
  }, []);

  // Splash stays visible while null — the guard never evaluates a pre-hydration
  // snapshot.
  if (boot === null) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        {/* OUTSIDE the Query/i18n providers on purpose: the theme is a DEVICE
            setting read from AsyncStorage, not a profile field, so it must not
            depend on a round-trip — and everything below, providers included,
            can then read it. */}
        <ThemeProvider initialPreference={boot.preference} fontsLoaded={boot.fontsLoaded}>
          <QueryClientProvider client={queryClient}>
            {/* Inside the QueryClientProvider: the interface language comes from
                GET /profile (i18n/I18nProvider), so this provider needs the Query
                cache the same way any screen does. */}
            <I18nProvider>
              <RootNavigator />
            </I18nProvider>
          </QueryClientProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function RootNavigator() {
  // Clears the Query cache on the signed-in -> signed-out edge.
  useAuthListener();
  const { scheme } = useTheme();
  const { stack } = useNavigationChrome();

  return (
    <>
      {/* Not "auto": an explicit light/dark pick that differs from the OS must
          still get status-bar glyphs that can be read against OUR background. */}
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false, ...stack }} />
    </>
  );
}
