// The ONLY file importing expo-secure-store. Provides the async token adapter the
// coordinator hydrates from (O2). Tokens live in the OS keychain/keystore ONLY,
// never AsyncStorage. The JWT pair is a single JSON value under one key — well
// under expo-secure-store's ~2 KB per-value limit.
//
// Kept OUT of the vitest graph (S4/R5): the coordinator injects this adapter; the
// tests inject an in-memory fake instead, so no expo import enters the Node runner.
import * as SecureStore from 'expo-secure-store';
import type { TokenPair } from '@budget/api-client';

import type { AsyncTokenStorage } from './coordinator';

const STORAGE_KEY = 'budget.auth';

// Runtime narrow (copied from web storage.ts): a corrupt/partial stored value is
// treated as logged-out rather than crashing hydration.
function isTokenPair(value: unknown): value is TokenPair {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { access_token?: unknown }).access_token === 'string' &&
    typeof (value as { refresh_token?: unknown }).refresh_token === 'string'
  );
}

export function createSecureStoreTokenStorage(): AsyncTokenStorage {
  return {
    async hydrate() {
      try {
        const raw = await SecureStore.getItemAsync(STORAGE_KEY);
        if (raw === null) return null;
        const parsed: unknown = JSON.parse(raw);
        return isTokenPair(parsed) ? parsed : null;
      } catch {
        // Keychain read error or malformed JSON — start logged out.
        return null;
      }
    },
    async write(pair) {
      await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(pair));
    },
    async clear() {
      await SecureStore.deleteItemAsync(STORAGE_KEY);
    },
  };
}
