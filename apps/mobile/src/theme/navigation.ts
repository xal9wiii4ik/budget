// Navigator chrome (headers, screen backgrounds, the tab bar) in ONE place.
//
// expo-router 57 sits on standard-navigation and @react-navigation/* is not a
// direct dependency here, so there is no router-level theme object to hand a
// palette to: `screenOptions` IS the whole mechanism. Every Stack and the Tabs
// spread these objects; per-screen options merge OVER them, so the three pushed
// screens that re-enable the header still get the themed one.
//
// This is also the only CONSUMER-FACING place a `fontFamily` is written: header
// titles and tab labels are rendered by the navigator, not by a `themedStyles`
// sheet, so `applyTypeface` never sees them and the mapping is done by hand
// here (and skipped entirely when the fonts failed to load, so the system font
// keeps honouring `fontWeight`).
import type { TextStyle, ViewStyle } from 'react-native';

import { INTER_FAMILY } from './applyTypeface';
import { themes, type ColorScheme } from './tokens';
import { useTheme } from './useTheme';

export interface StackChrome {
  /** Without this a pushed/modal screen paints the platform's white behind it. */
  contentStyle: ViewStyle;
  headerStyle: { backgroundColor: string };
  headerTintColor: string;
  headerTitleStyle: TextStyle;
}

export interface TabsChrome {
  headerStyle: { backgroundColor: string };
  headerTintColor: string;
  headerTitleStyle: TextStyle;
  tabBarStyle: ViewStyle;
  tabBarLabelStyle: TextStyle;
  tabBarActiveTintColor: string;
  tabBarInactiveTintColor: string;
}

export interface NavigationChrome {
  stack: StackChrome;
  tabs: TabsChrome;
}

/** `{ fontFamily }` when Inter is loaded, `{ fontWeight }` when it is not. */
function typeface(
  weight: 500 | 600,
  fontsLoaded: boolean,
): Pick<TextStyle, 'fontFamily' | 'fontWeight'> {
  return fontsLoaded
    ? { fontFamily: INTER_FAMILY[weight] }
    : { fontWeight: String(weight) as '500' | '600' };
}

function buildChrome(scheme: ColorScheme, fontsLoaded: boolean): NavigationChrome {
  const { colors, type } = themes[scheme];

  const header = {
    headerStyle: { backgroundColor: colors.surface },
    // Drives the back chevron (accent, the platform convention); the title
    // overrides it below so a heading never reads as a link.
    headerTintColor: colors.accent,
    headerTitleStyle: { color: colors.text, fontSize: type.lg, ...typeface(600, fontsLoaded) },
  };

  return {
    stack: { ...header, contentStyle: { backgroundColor: colors.bg } },
    tabs: {
      ...header,
      tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
      tabBarLabelStyle: { fontSize: type.xs, ...typeface(500, fontsLoaded) },
      tabBarActiveTintColor: colors.accent,
      tabBarInactiveTintColor: colors.textMuted,
    },
  };
}

// Four possible answers in a process's life (two schemes x fonts loaded or
// not), and screenOptions objects are compared by identity on every render.
const cache = new Map<string, NavigationChrome>();

export function useNavigationChrome(): NavigationChrome {
  const { scheme, fontsLoaded } = useTheme();
  const key = `${scheme}:${String(fontsLoaded)}`;

  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const chrome = buildChrome(scheme, fontsLoaded);
  cache.set(key, chrome);
  return chrome;
}
