// The ONLY file importing @react-native-async-storage/async-storage (the
// `secureStore.ts` pattern): the theme preference is an ordinary device
// setting, so it lives in AsyncStorage, never in the keychain — that is for
// secrets. All validation and defaulting live in the pure `themeStore.ts`;
// this module is just the wiring, and is kept OUT of the vitest graph.
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  readStoredPreference,
  writeStoredPreference,
  type PreferenceStorage,
  type ThemePreference,
} from './themeStore';

const storage: PreferenceStorage = {
  getItem: (key) => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
};

/** Awaited in the root layout's splash gate, so the first frame is already right. */
export function readPreference(): Promise<ThemePreference> {
  return readStoredPreference(storage);
}

export function writePreference(preference: ThemePreference): Promise<void> {
  return writeStoredPreference(storage, preference);
}
