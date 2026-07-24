import type { ApiClient, TokenPair } from '@budget/api-client';
import { describe, expect, it, vi } from 'vitest';

import { createCoordinator } from './coordinator';
import type { AsyncTokenStorage, ResumeSubscribe } from './coordinator';

// This suite exercises the coordinator CORE only. It imports ONLY @budget/api-client
// (+ the coordinator) and injects fakes for the storage adapter and resume seam, so
// NO react-native/expo module ever enters the vitest graph (S4/R5).

const pairA: TokenPair = { access_token: 'accessA', refresh_token: 'refreshA', token_type: 'bearer' };
const pairB: TokenPair = { access_token: 'accessB', refresh_token: 'refreshB', token_type: 'bearer' };

interface FakeStorage extends AsyncTokenStorage {
  current: () => TokenPair | null;
}

function createFakeStorage(initial: TokenPair | null = null): FakeStorage {
  let value = initial;
  return {
    hydrate: () => Promise.resolve(value),
    write: (pair) => {
      value = pair;
      return Promise.resolve();
    },
    clear: () => {
      value = null;
      return Promise.resolve();
    },
    current: () => value,
  };
}

type FakeResult = { data?: TokenPair; error?: unknown; response: Response };

function ok(pair: TokenPair): FakeResult {
  return { data: pair, response: new Response(null, { status: 200 }) };
}

function fail(status: number, detail: unknown = 'ERR'): FakeResult {
  return { error: { detail }, response: new Response(null, { status }) };
}

function createFakeAuthClient(handlers: {
  refresh?: () => FakeResult | Promise<FakeResult>;
  login?: () => FakeResult;
  logout?: () => FakeResult;
}) {
  const calls = { refresh: 0, login: 0, logout: 0 };
  const client = {
    POST: (path: string) => {
      if (path === '/auth/refresh') {
        calls.refresh += 1;
        return Promise.resolve(handlers.refresh?.() ?? fail(500));
      }
      if (path === '/auth/login') {
        calls.login += 1;
        return Promise.resolve(handlers.login?.() ?? fail(500));
      }
      if (path === '/auth/logout') {
        calls.logout += 1;
        return Promise.resolve(
          handlers.logout?.() ?? { data: undefined, response: new Response(null, { status: 204 }) },
        );
      }
      throw new Error(`unexpected POST ${path}`);
    },
  } as unknown as ApiClient;
  return { client, calls };
}

function createFakeFetch(responses: Response[]) {
  const requests: Request[] = [];
  let index = 0;
  const impl: typeof fetch = async (input) => {
    requests.push(input as Request);
    return responses[index++] ?? new Response(null, { status: 500 });
  };
  return { impl, requests };
}

// Simulates React Native's whatwg-fetch-derived Request polyfill: the body is held
// internally (as `_bodyInit`) and exposed ONLY via `text()`; the browser-spec `.body`
// ReadableStream getter is NOT implemented (stays `undefined`). Under undici/Node the
// real Request DOES expose `.body`, which is exactly why a `.body`-gated read passes
// the Node gate but drops every write body on-device (O4c). This fake reproduces the
// on-device shape so the divergence is caught in vitest.
function createRnPolyfillRequest(
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
): Request {
  let consumed = false;
  return {
    url,
    method: init.method,
    headers: new Headers(init.headers),
    body: undefined, // <-- RN polyfill: no ReadableStream getter.
    text: () => {
      if (consumed) throw new TypeError('Already read');
      consumed = true;
      return Promise.resolve(init.body);
    },
  } as unknown as Request;
}

// --- hydrate-once -> sync snapshot ----------------------------------------

describe('coordinator hydration (O2)', () => {
  it('starts unauthenticated, then exposes a SYNC snapshot after hydration resolves', async () => {
    const { client } = createFakeAuthClient({});
    const storage = createFakeStorage(pairA);
    const coordinator = createCoordinator({ authClient: client, storage });

    // Before hydration the mirror is empty (the splash gate blocks the guard here).
    expect(coordinator.getSnapshot()).toBe(false);
    expect(coordinator.getAccessToken()).toBeNull();

    await coordinator.ready;

    // After hydration reads are synchronous — no await in the guard.
    expect(coordinator.getSnapshot()).toBe(true);
    expect(coordinator.getAccessToken()).toBe('accessA');
  });
});

// --- single-flight dedup ---------------------------------------------------

describe('coordinator.refresh — single-flight (O3)', () => {
  it('collapses N concurrent refreshes into exactly one server call', async () => {
    const { client, calls } = createFakeAuthClient({ refresh: () => ok(pairB) });
    const storage = createFakeStorage(pairA);
    const coordinator = createCoordinator({ authClient: client, storage });
    await coordinator.ready;

    const results = await Promise.all([
      coordinator.refresh(),
      coordinator.refresh(),
      coordinator.refresh(),
      coordinator.refresh(),
      coordinator.refresh(),
    ]);

    expect(calls.refresh).toBe(1);
    expect(results).toEqual([true, true, true, true, true]);
    expect(storage.current()).toEqual(pairB);
    expect(coordinator.getAccessToken()).toBe('accessB');
  });

  it('clears inFlight after a flight settles so a later refresh starts a NEW flight', async () => {
    const { client, calls } = createFakeAuthClient({ refresh: () => ok(pairB) });
    const storage = createFakeStorage(pairA);
    const coordinator = createCoordinator({ authClient: client, storage });
    await coordinator.ready;

    await coordinator.refresh();
    await coordinator.refresh();

    expect(calls.refresh).toBe(2);
  });
});

// --- terminal failure ------------------------------------------------------

describe('coordinator.refresh — terminal failure', () => {
  it('clears the pair, flips the snapshot, sets wasSessionExpired, notifies', async () => {
    const { client } = createFakeAuthClient({ refresh: () => fail(401) });
    const storage = createFakeStorage(pairA);
    const coordinator = createCoordinator({ authClient: client, storage });
    await coordinator.ready;

    let notifications = 0;
    coordinator.subscribe(() => {
      notifications += 1;
    });

    const result = await coordinator.refresh();

    expect(result).toBe(false);
    expect(storage.current()).toBeNull();
    expect(coordinator.getSnapshot()).toBe(false);
    expect(coordinator.wasSessionExpired()).toBe(true);
    expect(notifications).toBeGreaterThan(0);
  });
});

// --- 401 -> refresh -> retry-once ------------------------------------------

describe('coordinator.authFetch — 401 -> refresh -> retry (O4)', () => {
  it('retries once with the rotated bearer after a single refresh', async () => {
    const { client, calls } = createFakeAuthClient({ refresh: () => ok(pairB) });
    const storage = createFakeStorage(pairA);
    const { impl, requests } = createFakeFetch([
      new Response(null, { status: 401 }),
      new Response(null, { status: 200 }),
    ]);
    const coordinator = createCoordinator({ authClient: client, storage, fetchImpl: impl });
    await coordinator.ready;

    const response = await coordinator.authFetch(new Request('http://localhost:8010/users/me'));

    expect(response.status).toBe(200);
    expect(calls.refresh).toBe(1);
    expect(requests).toHaveLength(2);
    expect(requests[0].headers.get('Authorization')).toBe('Bearer accessA');
    expect(requests[1].headers.get('Authorization')).toBe('Bearer accessB');
  });

  it('BODY PRESERVATION: the captured-init rebuild replays the retry with the same body', async () => {
    const { client } = createFakeAuthClient({ refresh: () => ok(pairB) });
    const storage = createFakeStorage(pairA);
    const { impl, requests } = createFakeFetch([
      new Response(null, { status: 401 }),
      new Response(null, { status: 200 }),
    ]);
    const coordinator = createCoordinator({ authClient: client, storage, fetchImpl: impl });
    await coordinator.ready;

    const body = JSON.stringify({ amount: 1299, note: 'coffee' });
    const response = await coordinator.authFetch(
      new Request('http://localhost:8010/transactions', {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    expect(response.status).toBe(200);
    expect(requests).toHaveLength(2);
    // The rebuild (no Request.clone dependency) replays the identical body.
    expect(await requests[1].text()).toBe(body);
    expect(requests[1].headers.get('Authorization')).toBe('Bearer accessB');
  });

  it('RN POLYFILL TRIPWIRE: body reaches the wire on send AND 401-replay even when input.body is undefined (O4c)', async () => {
    // Regression guard for the on-device platform divergence: RN's Request polyfill
    // leaves `.body` undefined and exposes the payload only via `text()`. A `.body`-gated
    // read would send `null` here, silently dropping every protected POST/PATCH body.
    // The method-based read must recover the payload on BOTH legs.
    const { client } = createFakeAuthClient({ refresh: () => ok(pairB) });
    const storage = createFakeStorage(pairA);
    const { impl, requests } = createFakeFetch([
      new Response(null, { status: 401 }),
      new Response(null, { status: 200 }),
    ]);
    const coordinator = createCoordinator({ authClient: client, storage, fetchImpl: impl });
    await coordinator.ready;

    const body = JSON.stringify({ amount: 4200, note: 'groceries' });
    const response = await coordinator.authFetch(
      createRnPolyfillRequest('http://localhost:8010/transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }),
    );

    expect(response.status).toBe(200);
    expect(requests).toHaveLength(2);
    // Initial send carries the body despite input.body === undefined...
    expect(await requests[0].text()).toBe(body);
    // ...and so does the post-refresh replay.
    expect(await requests[1].text()).toBe(body);
    expect(requests[0].headers.get('Authorization')).toBe('Bearer accessA');
    expect(requests[1].headers.get('Authorization')).toBe('Bearer accessB');
  });

  it('LOOP GUARD: does not retry a second time when the replay also 401s', async () => {
    const { client, calls } = createFakeAuthClient({ refresh: () => ok(pairB) });
    const storage = createFakeStorage(pairA);
    const { impl, requests } = createFakeFetch([
      new Response(null, { status: 401 }),
      new Response(null, { status: 401 }),
    ]);
    const coordinator = createCoordinator({ authClient: client, storage, fetchImpl: impl });
    await coordinator.ready;

    const response = await coordinator.authFetch(new Request('http://localhost:8010/users/me'));

    expect(response.status).toBe(401);
    expect(calls.refresh).toBe(1);
    expect(requests).toHaveLength(2);
  });

  it('EXCLUSION: a 401 on an /auth path never triggers a refresh', async () => {
    const refreshSpy = vi.fn(() => ok(pairB));
    const { client, calls } = createFakeAuthClient({ refresh: refreshSpy });
    const storage = createFakeStorage(pairA);
    const { impl, requests } = createFakeFetch([new Response(null, { status: 401 })]);
    const coordinator = createCoordinator({ authClient: client, storage, fetchImpl: impl });
    await coordinator.ready;

    const response = await coordinator.authFetch(new Request('http://localhost:8010/auth/login'));

    expect(response.status).toBe(401);
    expect(calls.refresh).toBe(0);
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
  });
});

// --- logout ----------------------------------------------------------------

describe('coordinator.logout', () => {
  it('revokes server-side then clears the mirror, not flagged as expired', async () => {
    const { client, calls } = createFakeAuthClient({});
    const storage = createFakeStorage(pairA);
    const coordinator = createCoordinator({ authClient: client, storage });
    await coordinator.ready;

    await coordinator.logout();

    expect(calls.logout).toBe(1);
    expect(storage.current()).toBeNull();
    expect(coordinator.getSnapshot()).toBe(false);
    expect(coordinator.wasSessionExpired()).toBe(false);
  });
});

// --- R3 resume-timeout branch ----------------------------------------------

describe('coordinator resume (O5/R3)', () => {
  it('abandons a stranded in-flight refresh on resume-timeout so the next 401 starts fresh', async () => {
    vi.useFakeTimers();
    try {
      let resume: (() => void) | undefined;
      const subscribeResume: ResumeSubscribe = (cb) => {
        resume = cb;
        return () => {};
      };

      // The first refresh NEVER settles (simulates a native request killed during
      // suspension whose promise never resolves); the second resolves normally.
      let refreshCalls = 0;
      const neverSettles = new Promise<FakeResult>(() => {});
      const client = {
        POST: (path: string) => {
          if (path === '/auth/refresh') {
            refreshCalls += 1;
            return refreshCalls === 1 ? neverSettles : Promise.resolve(ok(pairB));
          }
          throw new Error(`unexpected POST ${path}`);
        },
      } as unknown as ApiClient;

      const storage = createFakeStorage(pairA);
      const coordinator = createCoordinator({
        authClient: client,
        storage,
        subscribeResume,
        resumeRefreshTimeoutMs: 3000,
      });
      await coordinator.ready;

      // Start a refresh that hangs — inFlight is now the never-settling flight.
      const stranded = coordinator.refresh();
      void stranded.catch(() => {});
      expect(refreshCalls).toBe(1);

      // Resume fires; the grace period elapses without the flight settling.
      resume?.();
      await vi.advanceTimersByTimeAsync(3100);

      // inFlight was abandoned: a fresh 401 now starts a BRAND-NEW refresh that
      // succeeds — proving the stranded flight no longer strands every awaiter.
      const recovered = await coordinator.refresh();
      expect(recovered).toBe(true);
      expect(refreshCalls).toBe(2);
      expect(coordinator.getAccessToken()).toBe('accessB');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT abandon an in-flight refresh that settles within the grace period', async () => {
    vi.useFakeTimers();
    try {
      let resume: (() => void) | undefined;
      const subscribeResume: ResumeSubscribe = (cb) => {
        resume = cb;
        return () => {};
      };
      const { client, calls } = createFakeAuthClient({ refresh: () => ok(pairB) });
      const storage = createFakeStorage(pairA);
      const coordinator = createCoordinator({
        authClient: client,
        storage,
        subscribeResume,
        resumeRefreshTimeoutMs: 3000,
      });
      await coordinator.ready;

      const flight = coordinator.refresh();
      resume?.();
      // The flight settles on its own; advancing past the grace period must not
      // trigger a second refresh (contrast with the stranded case above).
      await flight;
      await vi.advanceTimersByTimeAsync(3100);

      expect(calls.refresh).toBe(1);
      expect(coordinator.getAccessToken()).toBe('accessB');
    } finally {
      vi.useRealTimers();
    }
  });
});
