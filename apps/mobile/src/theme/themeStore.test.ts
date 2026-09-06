import { describe, expect, it } from 'vitest';

import {
  DEFAULT_THEME_PREFERENCE,
  readStoredPreference,
  resolveScheme,
  THEME_PREFERENCE_KEY,
  writeStoredPreference,
  type PreferenceStorage,
} from './themeStore';

function fakeStorage(initial?: string): PreferenceStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(THEME_PREFERENCE_KEY, initial);
  return {
    values,
    getItem: (key) => Promise.resolve(values.get(key) ?? null),
    setItem: (key, value) => {
      values.set(key, value);
      return Promise.resolve();
    },
  };
}

describe('resolveScheme', () => {
  it('honours an explicit pick regardless of the OS scheme', () => {
    expect(resolveScheme('light', 'dark')).toBe('light');
    expect(resolveScheme('dark', 'light')).toBe('dark');
    expect(resolveScheme('light', null)).toBe('light');
    expect(resolveScheme('dark', undefined)).toBe('dark');
  });

  it('follows the OS scheme under `system`, and falls back to light when it is unknown', () => {
    expect(resolveScheme('system', 'dark')).toBe('dark');
    expect(resolveScheme('system', 'light')).toBe('light');
    expect(resolveScheme('system', null)).toBe('light');
    expect(resolveScheme('system', undefined)).toBe('light');
    // RN's own "the OS has not said" value.
    expect(resolveScheme('system', 'unspecified')).toBe('light');
  });
});

describe('readStoredPreference', () => {
  it('reads back each stored preference', async () => {
    for (const preference of ['light', 'dark', 'system'] as const) {
      await expect(readStoredPreference(fakeStorage(preference))).resolves.toBe(preference);
    }
  });

  it('falls back to `system` for a missing, corrupt or unknown value', async () => {
    await expect(readStoredPreference(fakeStorage())).resolves.toBe('system');
    await expect(readStoredPreference(fakeStorage('{"theme":"dark"}'))).resolves.toBe('system');
    await expect(readStoredPreference(fakeStorage('DARK'))).resolves.toBe('system');
    expect(DEFAULT_THEME_PREFERENCE).toBe('system');
  });

  it('does not throw when the store itself fails', async () => {
    const broken: PreferenceStorage = {
      getItem: () => Promise.reject(new Error('storage unavailable')),
      setItem: () => Promise.resolve(),
    };

    await expect(readStoredPreference(broken)).resolves.toBe('system');
  });
});

describe('writeStoredPreference', () => {
  it('writes under the same key web uses', async () => {
    const storage = fakeStorage();

    await writeStoredPreference(storage, 'dark');

    expect(storage.values.get('budget.theme')).toBe('dark');
  });

  it('swallows a failed write — the pick already applies in memory', async () => {
    const broken: PreferenceStorage = {
      getItem: () => Promise.resolve(null),
      setItem: () => Promise.reject(new Error('quota')),
    };

    await expect(writeStoredPreference(broken, 'light')).resolves.toBeUndefined();
  });
});
