// The theme context and its hook, in their own module so `themedStyles.ts` can
// read the theme without importing `ThemeProvider.tsx` (which imports
// `themedStyles`' consumers) — a cycle Metro would resolve to `undefined` at
// module-eval time.
import { createContext, useContext } from 'react';

import type { ColorScheme, Theme, ThemeColors } from './tokens';
import type { ThemePreference } from './themeStore';

export interface ThemeContextValue {
  /** The RESOLVED scheme — `system` is already applied. */
  scheme: ColorScheme;
  /** Shorthand for `theme.colors`; the same object. */
  colors: ThemeColors;
  /** The full `t` handed to `themedStyles` factories. */
  theme: Theme;
  /** False when Inter failed to load: every style keeps its own `fontWeight`. */
  fontsLoaded: boolean;
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  // The provider wraps the whole app inside the root layout's splash gate, so a
  // null here is a wiring mistake, not a state a user can reach — say so loudly
  // rather than silently rendering a light theme in the dark.
  if (value === null) throw new Error('useTheme() used outside <ThemeProvider>');
  return value;
}
