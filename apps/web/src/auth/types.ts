import type { TokenPair } from '@budget/api-client';

// These seams are WEB-ONLY (AM-3 / mobile constraint 2). The synchronous
// `read()` signature and the whole cross-tab machinery live entirely in
// apps/web/src/auth/ — they are NOT exported from any shared package. Mobile
// (1.8) re-implements against expo-secure-store's async model; it does not
// import these. `TokenPair` is imported only as a plain data type (allowed).

/**
 * Synchronous token store. Prod impl wraps a single localStorage key; the sync
 * read is what lets the route guard gate on token presence without a round-trip.
 */
export interface TokenStorage {
  read(): TokenPair | null;
  write(pair: TokenPair): void;
  clear(): void;
  /** Observe cross-tab mutations (the `storage` event). Returns an unsubscribe. */
  subscribe(onChange: () => void): () => void;
}

/**
 * Cross-tab exclusion. Prod impl uses `navigator.locks`; the fallback (locks
 * absent, e.g. Node/jsdom or ancient browsers) runs `fn` directly — the in-tab
 * single-flight promise still dedups within a tab.
 */
export interface LockManager {
  runExclusive<T>(name: string, fn: () => Promise<T>): Promise<T>;
}
