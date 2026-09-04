/**
 * Theme preference: pure storage + DOM application, no React.
 *
 * The contract is shared with the inline anti-flash script in index.html, which
 * reads the SAME key and sets the SAME attribute before the first paint — keep
 * the two in step. `system` deliberately REMOVES the attribute rather than
 * writing a resolved value: the OS setting can change while the app is open, and
 * the prefers-color-scheme block in tokens.css follows it for free.
 */

export type ThemePreference = 'light' | 'dark' | 'system';

export const THEME_STORAGE_KEY = 'budget.theme';

/** Display order of the segmented control: coolest → warmest is not the point; light → system → dark is. */
export const THEME_PREFERENCES: readonly ThemePreference[] = ['light', 'system', 'dark'];

function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

/** The stored pick, or 'system' when there is none (or storage is unavailable). */
export function readStoredTheme(): ThemePreference {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(raw) ? raw : 'system';
  } catch {
    // Safari private mode / storage disabled: the app still runs, on the OS theme.
    return 'system';
  }
}

export function storeTheme(preference: ThemePreference): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Nothing to do: the pick applies to this session and is simply not remembered.
  }
}

/** Writes the pick onto <html>. 'system' = no attribute = the media query decides. */
export function applyTheme(preference: ThemePreference): void {
  const root = document.documentElement;
  if (preference === 'system') {
    delete root.dataset.theme;
    return;
  }
  root.dataset.theme = preference;
}
