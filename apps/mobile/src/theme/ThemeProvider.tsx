// The one place the app resolves a colour scheme. It is deliberately the ONLY
// caller of `useColorScheme()` in the codebase (grep gate): every other module
// reads the RESOLVED scheme out of this context, so an explicit light/dark pick
// can never be second-guessed by the OS somewhere down the tree.
//
// Mounted inside SafeAreaProvider and OUTSIDE QueryClientProvider/I18nProvider:
// the theme is a device setting, it does not depend on the profile — and the
// preference is read behind the SAME splash gate as the token hydration, so the
// first painted frame is already in the right theme (the phone's version of
// web's anti-flash script).
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Appearance, useColorScheme } from 'react-native';

import { writePreference } from './preferenceStorage';
import { resolveScheme, type ThemePreference } from './themeStore';
import { themes } from './tokens';
import { ThemeContext, type ThemeContextValue } from './useTheme';

interface ThemeProviderProps {
  /** Read from AsyncStorage behind the splash gate by the root layout. */
  initialPreference: ThemePreference;
  /** Result of `loadFonts()`, awaited in the same gate. */
  fontsLoaded: boolean;
  children: ReactNode;
}

export function ThemeProvider({ initialPreference, fontsLoaded, children }: ThemeProviderProps) {
  const [preference, setPreferenceState] = useState<ThemePreference>(initialPreference);
  const systemScheme = useColorScheme();
  const scheme = resolveScheme(preference, systemScheme);

  // Native surfaces we do not render ourselves — Alert, the date picker's own
  // chrome, the keyboard, the navigator's shadows — read the OS appearance, not
  // our context. Forcing it here makes them follow an EXPLICIT pick for free;
  // `system` clears the override so an OS switch keeps working. Correctness
  // never depends on this: every RN surface we own resolves from the context
  // above, and in Expo Go the override may not propagate at all (probe R2).
  useEffect(() => {
    // 'unspecified' is RN 0.86's "clear the override, follow the OS" value
    // (older releases took null, which the current types reject).
    Appearance.setColorScheme(preference === 'system' ? 'unspecified' : preference);
  }, [preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    // Fire-and-forget: the pick is already applied in memory, and a failed
    // write costs the choice on the next cold start, nothing in this session.
    void writePreference(next);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      scheme,
      colors: themes[scheme].colors,
      theme: themes[scheme],
      fontsLoaded,
      preference,
      setPreference,
    }),
    [scheme, fontsLoaded, preference, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
