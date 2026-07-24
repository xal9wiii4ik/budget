import type { TokenPair } from '@budget/api-client';
import type { TokenStorage } from './types';

// Single localStorage key holding the JWT pair as JSON — the single source of
// truth across tabs. localStorage-token exposure (XSS) is an accepted, recorded
// architecture tradeoff (rotation limits blast radius); flagged, not silent.
const STORAGE_KEY = 'budget.auth';

function isTokenPair(value: unknown): value is TokenPair {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { access_token?: unknown }).access_token === 'string' &&
    typeof (value as { refresh_token?: unknown }).refresh_token === 'string'
  );
}

export function createLocalStorageTokenStorage(): TokenStorage {
  return {
    read() {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === null) return null;
      try {
        const parsed: unknown = JSON.parse(raw);
        return isTokenPair(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    write(pair) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(pair));
    },
    clear() {
      localStorage.removeItem(STORAGE_KEY);
    },
    subscribe(onChange) {
      const handler = (event: StorageEvent) => {
        // key === null fires on localStorage.clear(); react to that too.
        if (event.key === STORAGE_KEY || event.key === null) onChange();
      };
      window.addEventListener('storage', handler);
      return () => window.removeEventListener('storage', handler);
    },
  };
}
