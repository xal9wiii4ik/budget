// The mobile theme's data layer: the two colour palettes come from
// `@budget/shared` (the ONE place a colour value is written for either client —
// see packages/shared/src/palette.ts), the SCALES are the phone's own.
//
// Node-safe on purpose (imports only @budget/shared): `themeStore` and the
// vitest gate pull this in, and no react-native module may enter that graph.
// Nothing here reads React or StyleSheet — `themedStyles.ts` does that.
//
// Why the scales are not shared with web: web measures in rem against a 16px
// root, a phone measures in density-independent points and has its own type
// ramp. The numbers below happen to equal web's rem scale x16 (mobile-design
// decision 1), but they are OURS to move.
import { DARK_PALETTE, LIGHT_PALETTE, type Palette } from '@budget/shared';

export type ColorScheme = 'light' | 'dark';

/** Exactly the shared palette: 31 semantic names, no mobile-only colour. */
export type ThemeColors = Palette;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 12,
  /** Pill: any value past half the height rounds the same on both platforms. */
  full: 999,
} as const;

export const type = {
  xs: 12,
  sm: 13,
  md: 15,
  lg: 17,
  xl: 22,
  xxl: 28,
} as const;

type TabularNums = 'tabular-nums';

/**
 * Spread into EVERY Text that renders a formatMoney/formatAmount result, so
 * digits keep their columns while an amount changes (Inter carries `tnum` on
 * both platforms). Not a `readonly` array: RN types `fontVariant` as mutable.
 */
export const tnum: { readonly fontVariant: TabularNums[] } = { fontVariant: ['tabular-nums'] };

/** Minimum interactive height for touch targets (>= 44pt, agent UX baseline). */
export const TOUCH_TARGET = 44;

/**
 * The selected chip / segment pair, exposed once so the nine `chipSelected`
 * style sets and the two segment pickers cannot drift (task.md ruling 4).
 * A 1pt accent border is the phone's substitute for web's hover + focus ring:
 * dark `accentSoft` against `surfaceRaised` is 1.04 contrast, i.e. invisible
 * on its own. Typed structurally rather than as RN's ViewStyle/TextStyle to
 * keep this module free of react-native imports.
 */
export interface SelectedStyles {
  readonly chip: { readonly backgroundColor: string; readonly borderColor: string };
  readonly text: { readonly color: string; readonly fontWeight: '600' };
}

/** The `t` handed to every `themedStyles((t) => …)` factory and to `useTheme()`. */
export interface Theme {
  readonly scheme: ColorScheme;
  readonly colors: ThemeColors;
  readonly spacing: typeof spacing;
  readonly radius: typeof radius;
  readonly type: typeof type;
  readonly tnum: typeof tnum;
  readonly TOUCH_TARGET: typeof TOUCH_TARGET;
  readonly selected: SelectedStyles;
}

function buildTheme(scheme: ColorScheme, colors: ThemeColors): Theme {
  return {
    scheme,
    colors,
    spacing,
    radius,
    type,
    tnum,
    TOUCH_TARGET,
    selected: {
      chip: { backgroundColor: colors.accentSoft, borderColor: colors.accent },
      text: { color: colors.accentSoftFg, fontWeight: '600' },
    },
  };
}

/** The two frozen theme objects; identity is stable, so memoisation upstream works. */
export const themes: Readonly<Record<ColorScheme, Theme>> = {
  light: buildTheme('light', LIGHT_PALETTE),
  dark: buildTheme('dark', DARK_PALETTE),
};
