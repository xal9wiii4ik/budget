import type { LockManager } from './types';

/**
 * Cross-tab exclusion via the Web Locks API (`navigator.locks`, present in all
 * target browsers: Chrome 69+, Firefox 96+, Safari 15.4+). When absent (Node,
 * jsdom, ancient browsers) we run `fn` directly — the coordinator's in-tab
 * single-flight promise still dedups within a tab, and a cross-tab double-spend
 * is recovered by the re-read/adopt on the losing tab's next 401.
 */
export function createWebLockManager(): LockManager {
  return {
    async runExclusive(name, fn) {
      if (typeof navigator !== 'undefined' && 'locks' in navigator) {
        // `Awaited` collapses the nested promise from the callback's return.
        return await navigator.locks.request(name, { mode: 'exclusive' }, () => fn());
      }
      return fn();
    },
  };
}
