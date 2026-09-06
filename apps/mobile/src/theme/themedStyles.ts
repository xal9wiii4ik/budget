// The factory every screen and component uses instead of a module-level
// `StyleSheet.create`:
//
//   const useStyles = themedStyles((t) => ({ box: { backgroundColor: t.colors.surface } }));
//   function Screen() { const styles = useStyles(); … }
//
// Why a factory and not a plain hook: a module-level `StyleSheet.create` is
// evaluated ONCE at import, so no value inside it can ever follow a theme —
// that, not the palette, was the structural cost of this scope.
//
// Cost control: the sheet is built at most once per (scheme, fontsLoaded) pair
// and cached on the closure, so a render allocates nothing and a theme switch
// costs one `StyleSheet.create` per module. `memo`'d rows still flip, because
// the hook subscribes to the theme context.
import { StyleSheet, type ImageStyle, type TextStyle, type ViewStyle } from 'react-native';

import { applyTypeface } from './applyTypeface';
import { themes, type Theme } from './tokens';
import { useTheme } from './useTheme';

// RN declares this type inside its StyleSheet namespace but does not export it.
type NamedStyles<T> = { [P in keyof T]: ViewStyle | TextStyle | ImageStyle };

export function themedStyles<T extends NamedStyles<T>>(factory: (t: Theme) => T): () => T {
  const cache = new Map<string, T>();

  return function useStyles(): T {
    const { scheme, fontsLoaded } = useTheme();
    const key = `${scheme}:${String(fontsLoaded)}`;

    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    // applyTypeface runs BEFORE StyleSheet.create: it rewrites `fontWeight` into
    // the matching static Inter family, and a registered sheet is frozen.
    const created = StyleSheet.create(applyTypeface(factory(themes[scheme]), fontsLoaded));
    cache.set(key, created);
    return created;
  };
}
