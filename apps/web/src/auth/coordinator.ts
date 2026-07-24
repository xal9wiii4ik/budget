import {
  login as authLogin,
  refresh as authRefresh,
  logout as authLogout,
} from '@budget/api-client';
import type { ApiClient, TokenPair } from '@budget/api-client';

import { ApiError } from '../lib/query';
import type { LockManager, TokenStorage } from './types';

const REFRESH_LOCK = 'budget-auth-refresh';

// Paths that must NEVER trigger the 401->refresh->retry path (belt-and-suspenders
// on top of the two-client design: authClient bypasses authFetch entirely).
const AUTH_PATHS = ['/auth/login', '/auth/refresh', '/auth/logout', '/auth/register'];

export interface Coordinator {
  /** Current access token, or null when logged out. */
  getAccessToken(): string | null;
  /** Cheap synchronous gate for the route guard. */
  hasToken(): boolean;
  /** useSyncExternalStore snapshot (boolean; stable by value). */
  getSnapshot(): boolean;
  /** useSyncExternalStore subscribe. */
  subscribe(onChange: () => void): () => void;
  /**
   * True only when the token pair was cleared by a TERMINAL refresh failure
   * (not by an intentional logout or a never-logged-in cold visit). The guard
   * uses it to decide whether to append `reason=expired` on the redirect.
   */
  wasSessionExpired(): boolean;
  /** The custom fetch wrapper passed to the protected apiClient. */
  authFetch(input: Request): Promise<Response>;
  /** Authenticate and store the token pair; throws ApiError on failure. */
  login(email: string, password: string): Promise<void>;
  /** Revoke the refresh token server-side, then clear + notify. */
  logout(): Promise<void>;
  /** Single-flight refresh used by authFetch on 401. Resolves true on success. */
  refresh(): Promise<boolean>;
}

export interface CoordinatorDeps {
  /** Plain client (no bearer, no retry) for the /auth endpoints. */
  authClient: ApiClient;
  storage: TokenStorage;
  locks: LockManager;
  /** The real network fetch used inside authFetch (injectable for tests). */
  fetchImpl?: typeof fetch;
}

function isAuthPath(url: string): boolean {
  try {
    const { pathname } = new URL(url);
    return AUTH_PATHS.some((path) => pathname.endsWith(path));
  } catch {
    return false;
  }
}

export function createCoordinator(deps: CoordinatorDeps): Coordinator {
  const { authClient, storage, locks } = deps;
  const doFetch = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);

  // In-memory mirror of the stored pair — the source React reads. Kept in sync
  // with storage on every mutation and re-hydrated on cross-tab storage events.
  let current: TokenPair | null = storage.read();
  const listeners = new Set<() => void>();
  // In-tab single-flight: concurrent 401s all await the same refresh flight.
  let inFlight: Promise<boolean> | null = null;
  // Set only when a terminal refresh failure clears the pair — lets the guard
  // distinguish an expired session from an intentional logout / cold visit.
  let sessionExpired = false;

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function setTokens(pair: TokenPair | null): void {
    current = pair;
    if (pair) storage.write(pair);
    else storage.clear();
    notify();
  }

  // Re-hydrate from storage when another tab writes/clears the key.
  storage.subscribe(() => {
    current = storage.read();
    // Invariant: a live token pair means the session is not expired. A cross-tab
    // login (or adopt via re-hydration) clears any stale terminal-failure flag.
    if (current !== null) sessionExpired = false;
    notify();
  });

  function getAccessToken(): string | null {
    return current?.access_token ?? null;
  }

  function hasToken(): boolean {
    return current !== null;
  }

  function subscribe(onChange: () => void): () => void {
    listeners.add(onChange);
    return () => {
      listeners.delete(onChange);
    };
  }

  async function runRefresh(triggeringRefreshToken: string): Promise<boolean> {
    return locks.runExclusive(REFRESH_LOCK, async () => {
      // Re-read AFTER acquiring the lock: another tab may have already rotated
      // while we queued. The single-use refresh token makes a double-spend a hard
      // 401, so if storage now holds a DIFFERENT refresh token, adopt it without
      // spending ours on the server.
      const stored = storage.read();
      if (stored === null) {
        // Another tab logged out (or storage was destroyed) while we queued:
        // sync the mirror, do NOT spend the revoked token, do NOT claim the
        // session "expired" (this is an intentional logout, not a terminal
        // refresh failure).
        current = null;
        notify();
        return false;
      }
      if (stored.refresh_token !== triggeringRefreshToken) {
        current = stored;
        notify();
        return true;
      }

      const result = await authRefresh(authClient, stored.refresh_token);
      if (result.error !== undefined || !result.response.ok || result.data === undefined) {
        // Terminal failure: clear + notify so the guard redirects. authFetch does
        // NOT navigate imperatively — the React guard reacts to the flipped snapshot.
        sessionExpired = true;
        setTokens(null);
        return false;
      }
      setTokens(result.data);
      return true;
    });
  }

  function refresh(): Promise<boolean> {
    if (inFlight) return inFlight;
    const triggeringRefreshToken = current?.refresh_token ?? null;
    if (triggeringRefreshToken === null) return Promise.resolve(false);
    inFlight = runRefresh(triggeringRefreshToken).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function withBearer(request: Request, token: string | null): void {
    // Mutate headers in place (acceptable latitude per AM-7 — no new Request is
    // constructed from `request`, so the body stream is not disturbed here).
    if (token) request.headers.set('Authorization', `Bearer ${token}`);
  }

  async function authFetch(input: Request): Promise<Response> {
    const excluded = isAuthPath(input.url);
    // AM-7: clone BEFORE any bearer attach / send. Cloning after the body stream
    // is disturbed throws; the pristine clone is what we replay on retry.
    const retry = input.clone();

    withBearer(input, getAccessToken());
    let response = await doFetch(input);

    if (response.status === 401 && !excluded) {
      const refreshed = await refresh();
      if (refreshed) {
        // Retry ONCE with the freshly rotated bearer. A second 401 is returned
        // as-is (loop guard) — the guard/query then handle it.
        withBearer(retry, getAccessToken());
        response = await doFetch(retry);
      }
    }

    return response;
  }

  async function login(email: string, password: string): Promise<void> {
    const result = await authLogin(authClient, email, password);
    if (result.error !== undefined || !result.response.ok || result.data === undefined) {
      throw new ApiError(result.response.status, result.error);
    }
    sessionExpired = false;
    setTokens(result.data);
  }

  async function logout(): Promise<void> {
    const pair = current;
    sessionExpired = false;
    if (pair) {
      // Best-effort server revoke; clear locally regardless of its outcome.
      try {
        await authLogout(authClient, pair.refresh_token);
      } catch {
        // network/other failure — still clear locally below.
      }
    }
    setTokens(null);
  }

  return {
    getAccessToken,
    hasToken,
    getSnapshot: hasToken,
    subscribe,
    wasSessionExpired: () => sessionExpired,
    authFetch,
    login,
    logout,
    refresh,
  };
}
