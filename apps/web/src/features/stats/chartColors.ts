import { useSyncExternalStore } from 'react';

import { useTheme } from '../../theme/useTheme';

/**
 * The chart palette, read out of the design tokens at render time.
 *
 * Recharts takes colours as plain strings on SVG attributes (`fill`, `stroke`),
 * and SVG presentation attributes do NOT accept `var(--token)` — so the tokens
 * are resolved here instead of being written into the markup. Everything below
 * still has exactly one source of truth: `--color-chart-*` in tokens.css.
 *
 * The read is cached per RESOLVED theme, so it happens once per theme and not on
 * every render; the theme preference plus the OS media query are what invalidate
 * it. Both are already applied to <html> before React re-renders (theme.ts sets
 * the attribute synchronously), so the computed values read here are the new
 * ones, never the outgoing theme's.
 */

const TOKEN_BY_ROLE = {
  income: '--color-chart-income',
  expense: '--color-chart-expense',
  net: '--color-chart-net',
  grid: '--color-chart-grid',
  axis: '--color-chart-axis',
  cursor: '--color-chart-cursor',
} as const;

export type ChartColors = Record<keyof typeof TOKEN_BY_ROLE, string>;

type ResolvedTheme = 'light' | 'dark';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function subscribeSystemTheme(onChange: () => void): () => void {
  const media = window.matchMedia(DARK_QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

function systemPrefersDark(): boolean {
  return window.matchMedia(DARK_QUERY).matches;
}

function readChartColors(): ChartColors {
  const computed = getComputedStyle(document.documentElement);
  const read = (token: string): string => computed.getPropertyValue(token).trim();
  return {
    income: read(TOKEN_BY_ROLE.income),
    expense: read(TOKEN_BY_ROLE.expense),
    net: read(TOKEN_BY_ROLE.net),
    grid: read(TOKEN_BY_ROLE.grid),
    axis: read(TOKEN_BY_ROLE.axis),
    cursor: read(TOKEN_BY_ROLE.cursor),
  };
}

// One entry, keyed by the theme it was read under: the palette is a function of
// the theme and of nothing else. Stable identity also keeps Recharts from
// re-rendering the series on every parent render.
let cache: { theme: ResolvedTheme; colors: ChartColors } | null = null;

function chartColorsFor(theme: ResolvedTheme): ChartColors {
  if (cache !== null && cache.theme === theme) return cache.colors;
  const colors = readChartColors();
  cache = { theme, colors };
  return colors;
}

export function useChartColors(): ChartColors {
  const { theme } = useTheme();
  const prefersDark = useSyncExternalStore(
    subscribeSystemTheme,
    systemPrefersDark,
    systemPrefersDark,
  );
  const resolved: ResolvedTheme = theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme;
  return chartColorsFor(resolved);
}
