// Pure theme-preference logic: validate, resolve, read/write over an INJECTED
// storage seam (the `secureStore.ts` pattern). No react-native, no
// async-storage import — `preferenceStorage.ts` owns that and this module is
// what the vitest gate exercises.
//
// The preference lives on the DEVICE, not the profile: a theme belongs to a
// screen, not to an account (phone dark, desktop light is a normal life). Key
// and values are IDENTICAL to web's `theme/theme.ts` (`budget.theme`,
// light|dark|system), so the two clients read the same way even though the two
// stores are unrelated. Not the keychain: that is for secrets.
import type { ColorScheme } from './tokens';

export type ThemePreference = 'light' | 'dark' | 'system';

export const THEME_PREFERENCE_KEY = 'budget.theme';

export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'system';

/** The async key/value seam; AsyncStorage satisfies it, tests inject a fake. */
export interface PreferenceStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

/**
 * `system` deliberately resolves through the OS scheme instead of being
 * flattened at write time, so an OS switch while the app is open is free.
 *
 * `systemScheme` is typed loosely because RN reports 'light' | 'dark' |
 * 'unspecified' | null | undefined and this module must not import react-native
 * to say so: anything that is not 'dark' resolves to light, which is also the
 * honest answer for "the OS has not told us yet".
 */
export function resolveScheme(
  preference: ThemePreference,
  systemScheme: string | null | undefined,
): ColorScheme {
  if (preference === 'light' || preference === 'dark') return preference;
  return systemScheme === 'dark' ? 'dark' : 'light';
}

/**
 * A missing, corrupt or unknown stored value is `system` — never a throw and
 * never `light`: the splash gate awaits this, so a bad byte in storage must not
 * hold the first frame, and defaulting to a CONCRETE scheme would silently
 * override the OS for everyone whose storage failed to read.
 */
export async function readStoredPreference(storage: PreferenceStorage): Promise<ThemePreference> {
  try {
    const raw = await storage.getItem(THEME_PREFERENCE_KEY);
    return isThemePreference(raw) ? raw : DEFAULT_THEME_PREFERENCE;
  } catch {
    return DEFAULT_THEME_PREFERENCE;
  }
}

/**
 * Best-effort: the picked theme already applies in memory, so a failed write
 * costs the choice on the next cold start, not this session. Swallowed rather
 * than surfaced — there is no recovery a user could perform.
 */
export async function writeStoredPreference(
  storage: PreferenceStorage,
  preference: ThemePreference,
): Promise<void> {
  try {
    await storage.setItem(THEME_PREFERENCE_KEY, preference);
  } catch {
    // ignored on purpose (see above)
  }
}
