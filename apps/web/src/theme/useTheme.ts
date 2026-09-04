import { useSyncExternalStore } from 'react';

import {
  applyTheme,
  readStoredTheme,
  storeTheme,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from './theme';

// One module-level snapshot, exactly like the auth coordinator's: the preference
// is a single global fact, and useSyncExternalStore needs a stable value.
let snapshot: ThemePreference = readStoredTheme();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  // Cross-tab: the same `storage` channel auth already uses. Cheap, and a theme
  // that changes in one tab but not the other looks like a bug to the user.
  const handler = (event: StorageEvent) => {
    // key === null fires on localStorage.clear() — re-read then too.
    if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
    const next = readStoredTheme();
    if (next === snapshot) return;
    snapshot = next;
    applyTheme(next);
    emit();
  };
  window.addEventListener('storage', handler);
  return () => {
    listeners.delete(onStoreChange);
    window.removeEventListener('storage', handler);
  };
}

function getSnapshot(): ThemePreference {
  return snapshot;
}

export function setTheme(preference: ThemePreference): void {
  if (preference === snapshot) return;
  snapshot = preference;
  storeTheme(preference);
  applyTheme(preference);
  emit();
}

/** Current theme preference + setter. The attribute is already on <html> at this
 *  point (index.html's inline script), so nothing here runs on mount. */
export function useTheme(): {
  theme: ThemePreference;
  setTheme: (preference: ThemePreference) => void;
} {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { theme, setTheme };
}
