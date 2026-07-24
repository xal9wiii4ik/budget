// Mobile auth coordinator (O1–O7). COPY of web's pattern, NOT a shared package
// (O1/S5): single-flight refresh + reactive-only 401->refresh->retry, reusing ONLY
// login/refresh/logout + ApiError/TokenPair from @budget/api-client. Everything
// cross-tab from web (navigator.locks, storage events, re-read/adopt double-spend
// guard, cross-tab logout) is DELETED — one RN runtime, one process (O3).
//
// This module is DI-architected and imports ONLY @budget/api-client so the whole
// coordinator core is vitest-testable under Node with NO react-native/expo import
// in the graph (S4/R5). The two platform seams — expo-secure-store (secureStore.ts)
// and RN AppState (resume.ts) — are INJECTED via the interfaces declared here; the
// vitest suite replaces them with fakes and never imports those files.
import {
  login as authLogin,
  refresh as authRefresh,
  logout as authLogout,
  ApiError,
} from '@budget/api-client';
import type { ApiClient, TokenPair } from '@budget/api-client';

// Paths that must NEVER trigger the 401->refresh->retry path (belt-and-suspenders
// on top of the two-client design: authClient bypasses authFetch entirely).
const AUTH_PATHS = ['/auth/login', '/auth/refresh', '/auth/logout', '/auth/register'];

// Grace period (O5/R3): how long, on an AppState resume, we wait for a suspended
// in-flight refresh to settle before abandoning it so the next 401 starts fresh.
const DEFAULT_RESUME_REFRESH_TIMEOUT_MS = 4000;

/**
 * Async token store backed by expo-secure-store (O2). The coordinator hydrates
 * ONCE into an in-memory mirror behind a splash gate; after that reads are sync.
 * The prod adapter lives in secureStore.ts (the only file importing the native
 * module); tests inject a plain in-memory fake.
 */
export interface AsyncTokenStorage {
  hydrate(): Promise<TokenPair | null>;
  write(pair: TokenPair): Promise<void>;
  clear(): Promise<void>;
}

/**
 * Subscribe to app foreground-resume events (O5). Returns an unsubscribe. The prod
 * impl wraps RN AppState (resume.ts); tests inject a fake that captures the handler.
 */
export type ResumeSubscribe = (onResume: () => void) => () => void;

/** Injectable timer seam so the R3 resume-timeout branch is fake-timer-testable. */
export interface TimerSeam {
  setTimeout: (handler: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface Coordinator {
  /** Resolves once the initial secure-store hydration completes (splash gate, O2). */
  ready: Promise<void>;
  /** Current access token, or null when logged out. */
  getAccessToken(): string | null;
  /** Cheap synchronous gate for the route guard. */
  hasToken(): boolean;
  /** useSyncExternalStore snapshot (boolean; stable by value). */
  getSnapshot(): boolean;
  /** useSyncExternalStore subscribe. */
  subscribe(onChange: () => void): () => void;
  /**
   * True only when the token pair was cleared by a TERMINAL refresh failure (not by
   * an intentional logout or a never-logged-in cold start). The guard uses it to
   * decide whether to append `reason=expired` on the redirect (O6).
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
  storage: AsyncTokenStorage;
  /** AppState resume subscription (O5). Omitted in tests that don't exercise resume. */
  subscribeResume?: ResumeSubscribe;
  /** The real network fetch used inside authFetch (injectable for tests). */
  fetchImpl?: typeof fetch;
  /** Timer seam for the R3 resume-timeout race (injectable for fake timers). */
  timers?: TimerSeam;
  /** Override the resume-refresh grace period (tests use a small value). */
  resumeRefreshTimeoutMs?: number;
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
  const { authClient, storage } = deps;
  const doFetch = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timers: TimerSeam = deps.timers ?? {
    setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const resumeRefreshTimeoutMs =
    deps.resumeRefreshTimeoutMs ?? DEFAULT_RESUME_REFRESH_TIMEOUT_MS;

  // In-memory mirror of the stored pair — the source React reads synchronously.
  // Null until hydration resolves; the splash gate (O2) keeps guards from reading
  // it before `ready`.
  let current: TokenPair | null = null;
  const listeners = new Set<() => void>();
  // In-process single-flight: concurrent 401s all await the same refresh flight (O3).
  let inFlight: Promise<boolean> | null = null;
  // Set only when a terminal refresh failure clears the pair — lets the guard
  // distinguish an expired session from an intentional logout / cold start.
  let sessionExpired = false;

  function notify(): void {
    for (const listener of listeners) listener();
  }

  // Memory-sync mirror update + notify, returning the async persist promise. O2:
  // writes are memory-sync + awaited SecureStore inside the already-async flows.
  function setTokens(pair: TokenPair | null): Promise<void> {
    current = pair;
    notify();
    return pair ? storage.write(pair) : storage.clear();
  }

  // Async-hydrate-once (O2): read the persisted pair into the mirror, then notify so
  // the splash gate and any early subscriber re-read the settled snapshot.
  const ready = storage
    .hydrate()
    .then((pair) => {
      // NIT 13: only adopt the hydrated pair if nothing newer already wrote the
      // mirror. The splash gate keeps login unmounted until `ready`, but the
      // coordinator is DI'd and consumed outside that gate's control — guarding here
      // makes "no stale writer may clobber newer auth state" a local invariant.
      if (current === null) current = pair;
    })
    .catch(() => {
      current = null;
    })
    .finally(() => {
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
    const result = await authRefresh(authClient, triggeringRefreshToken);
    if (current?.refresh_token !== triggeringRefreshToken) {
      // Mirror moved on while we were in flight — logout, a new login, or a fresh
      // refresh started after THIS flight was abandoned on resume (O5/R3). Applying
      // either arm now would clobber newer auth state (a resurrected zombie session,
      // or a spurious "session expired" after a replacement flight already succeeded).
      // Bail without touching tokens or the flag; report the current mirror's state.
      return current !== null;
    }
    if (result.error !== undefined || !result.response.ok || result.data === undefined) {
      // Terminal failure: clear + notify so the guard redirects. authFetch does NOT
      // navigate imperatively — the React guard reacts to the flipped snapshot (O6).
      sessionExpired = true;
      await setTokens(null);
      return false;
    }
    await setTokens(result.data);
    return true;
  }

  function refresh(): Promise<boolean> {
    if (inFlight) return inFlight;
    const triggeringRefreshToken = current?.refresh_token ?? null;
    if (triggeringRefreshToken === null) return Promise.resolve(false);
    const flight: Promise<boolean> = runRefresh(triggeringRefreshToken).finally(() => {
      // Identity-guarded clear: an abandoned flight (O5/R3) that settles LATE must not
      // null a REPLACEMENT flight's registration and reopen the single-flight window
      // (which would let the next 401 double-spend the same refresh token).
      if (inFlight === flight) inFlight = null;
    });
    inFlight = flight;
    return flight;
  }

  async function authFetch(input: Request): Promise<Response> {
    const excluded = isAuthPath(input.url);

    // CAPTURED-INIT REBUILD (O4): read the body ONCE as text and capture
    // method/url/headers, then build FRESH Request objects for the initial send and
    // the 401 retry. This does NOT depend on Request.clone() (RN's whatwg-fetch
    // Request has a documented history of body-clone quirks); a plain JS string body
    // is replayable with certainty. Auth endpoints never reach here, so bodies are
    // JSON or empty — no FormData/stream edge.
    //
    // Body presence is decided by METHOD, NOT by `input.body`. `Request.prototype.body`
    // is the browser-spec ReadableStream getter, which RN's whatwg-fetch-derived
    // polyfill does NOT implement — it holds the body internally as `_bodyInit` and
    // leaves `.body` undefined. Reading `input.body` would therefore be `undefined` for
    // a real on-device JSON POST and silently drop EVERY protected write body (O4c;
    // undici/Node has `.body`, so this divergence is invisible to the Node gate).
    // `Body.text()` IS implemented by both undici and the RN polyfill, so we read it for
    // any body-bearing method and treat an empty string as "no body".
    //
    // DROPPED-FIELDS CONTRACT (O4): this rebuild is NOT clone-parity. It carries over
    // exactly url / method / headers / body / signal; EVERY other RequestInit field
    // (credentials, mode, cache, redirect, referrer, integrity, keepalive, priority,
    // …) is intentionally dropped. Protected app requests only ever set the carried
    // fields, but the next engineer must not assume a field survives just because
    // `input` had it — add it here explicitly if a hook starts relying on it. `signal`
    // is carried on BOTH legs so an aborted screen neither sends the initial request
    // nor replays the 401 retry after refresh.
    const url = input.url;
    const method = input.method;
    const baseHeaders = new Headers(input.headers);
    const signal = input.signal ?? undefined;
    const hasBodyMethod = method !== 'GET' && method !== 'HEAD';
    let bodyText: string | null = null;
    if (hasBodyMethod) {
      const text = await input.text();
      bodyText = text === '' ? null : text;
    }

    const build = (token: string | null): Request => {
      const headers = new Headers(baseHeaders);
      if (token) headers.set('Authorization', `Bearer ${token}`);
      return new Request(url, { method, headers, body: bodyText ?? undefined, signal });
    };

    let response = await doFetch(build(getAccessToken()));

    if (response.status === 401 && !excluded) {
      const refreshed = await refresh();
      if (refreshed) {
        // Retry ONCE with the freshly rotated bearer. A second 401 is returned
        // as-is (loop guard) — the guard/query then handle it.
        response = await doFetch(build(getAccessToken()));
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
    await setTokens(result.data);
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
    await setTokens(null);
  }

  // O5/R3: on foreground resume, re-evaluate the in-flight refresh. The JS thread
  // may have been suspended mid-refresh; single-flight still holds, but a suspended
  // native request can be killed by the OS and its promise may NEVER settle. So we
  // race the pending flight against a short timeout: if it hasn't settled by then,
  // abandon it (clear inFlight) so the next 401 starts a fresh refresh. Worst case
  // is one extra refresh attempt — never a spent-token double-use, since the rebuilt
  // request only replays AFTER a fresh refresh resolves.
  function onResume(): void {
    // Re-read the current snapshot: a refresh that terminally failed while
    // backgrounded already cleared the mirror; the guard reacts on resume.
    notify();
    const pending = inFlight;
    if (pending === null) return;

    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const handle = timers.setTimeout(() => {
      if (!settled && inFlight === pending) {
        // Abandon the stranded flight; single-flight is preserved because a new
        // refresh() call will now start a brand-new flight.
        inFlight = null;
      }
    }, resumeRefreshTimeoutMs);
    // NIT 7: clear the grace timer once the flight settles so it doesn't linger as a
    // guarded no-op (and TimerSeam.clearTimeout is no longer dead surface). Each
    // stacked resume gets its own handle, each cleared when its watched flight settles.
    void pending.finally(() => {
      timers.clearTimeout(handle);
    });
  }

  deps.subscribeResume?.(onResume);

  return {
    ready,
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
