import type { ApiClient, TokenPair } from '@budget/api-client';
import { describe, expect, it, vi } from 'vitest';

import { createCoordinator } from './coordinator';
import type { LockManager, TokenStorage } from './types';

// --- test doubles ---------------------------------------------------------

const pairA: TokenPair = { access_token: 'accessA', refresh_token: 'refreshA', token_type: 'bearer' };
const pairB: TokenPair = { access_token: 'accessB', refresh_token: 'refreshB', token_type: 'bearer' };
const pairC: TokenPair = { access_token: 'accessC', refresh_token: 'refreshC', token_type: 'bearer' };

interface FakeStorage extends TokenStorage {
  /** Simulate another tab rotating the key WITHOUT firing our subscribe. */
  setSilently(pair: TokenPair | null): void;
}

function createFakeStorage(initial: TokenPair | null = null): FakeStorage {
  let value = initial;
  const subs = new Set<() => void>();
  return {
    read: () => value,
    write: (pair) => {
      value = pair;
    },
    clear: () => {
      value = null;
    },
    subscribe: (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    setSilently: (pair) => {
      value = pair;
    },
  };
}

interface FakeLocks extends LockManager {
  maxConcurrent: () => number;
}

function createFakeLocks(): FakeLocks {
  let active = 0;
  let peak = 0;
  return {
    runExclusive: async (_name, fn) => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        return await fn();
      } finally {
        active -= 1;
      }
    },
    maxConcurrent: () => peak,
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
  refresh?: () => FakeResult;
  login?: () => FakeResult;
  logout?: () => FakeResult;
}) {
  const calls = { refresh: 0, login: 0, logout: 0 };
  const client = {
    POST: async (path: string) => {
      if (path === '/auth/refresh') {
        calls.refresh += 1;
        return handlers.refresh?.() ?? fail(500);
      }
      if (path === '/auth/login') {
        calls.login += 1;
        return handlers.login?.() ?? fail(500);
      }
      if (path === '/auth/logout') {
        calls.logout += 1;
        return { data: undefined, response: new Response(null, { status: 204 }) };
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

// --- tests ----------------------------------------------------------------

describe('coordinator.refresh — single-flight', () => {
  it('collapses N concurrent refreshes into exactly one server call', async () => {
    const { client, calls } = createFakeAuthClient({ refresh: () => ok(pairB) });
    const storage = createFakeStorage(pairA);
    const locks = createFakeLocks();
    const coordinator = createCoordinator({ authClient: client, storage, locks });

    const results = await Promise.all([
      coordinator.refresh(),
      coordinator.refresh(),
      coordinator.refresh(),
      coordinator.refresh(),
      coordinator.refresh(),
    ]);

    expect(calls.refresh).toBe(1);
    expect(results).toEqual([true, true, true, true, true]);
    expect(storage.read()).toEqual(pairB);
    // Single-flight: the lock body never runs concurrently.
    expect(locks.maxConcurrent()).toBe(1);
  });
});

describe('coordinator.refresh — re-read/adopt after lock', () => {
  it('HAPPY PATH: when storage still holds our token, it calls the server', async () => {
    const { client, calls } = createFakeAuthClient({ refresh: () => ok(pairB) });
    const storage = createFakeStorage(pairA);
    const coordinator = createCoordinator({ authClient: client, storage, locks: createFakeLocks() });

    const result = await coordinator.refresh();

    expect(result).toBe(true);
    expect(calls.refresh).toBe(1);
    expect(coordinator.getAccessToken()).toBe('accessB');
  });

  it('ADOPT: when another tab already rotated, it adopts the stored pair WITHOUT a server call', async () => {
    const { client, calls } = createFakeAuthClient({ refresh: () => ok(pairB) });
    const storage = createFakeStorage(pairA);
    const coordinator = createCoordinator({ authClient: client, storage, locks: createFakeLocks() });

    // Another tab rotated to pairC (different refresh token) after we queued.
    storage.setSilently(pairC);
    const result = await coordinator.refresh();

    expect(result).toBe(true);
    // Contrast with the happy path above: the server is NOT spent here.
    expect(calls.refresh).toBe(0);
    expect(coordinator.getAccessToken()).toBe('accessC');
  });

  it('CROSS-TAB LOGOUT: when storage was cleared while queued, syncs mirror, no server call, not expired', async () => {
    const { client, calls } = createFakeAuthClient({ refresh: () => ok(pairB) });
    const storage = createFakeStorage(pairA);
    const coordinator = createCoordinator({ authClient: client, storage, locks: createFakeLocks() });

    let notifications = 0;
    coordinator.subscribe(() => {
      notifications += 1;
    });

    // Another tab logged out (cleared the key) after we captured the trigger token.
    storage.setSilently(null);
    const result = await coordinator.refresh();

    expect(result).toBe(false);
    // Contrast with the terminal-failure case: no server round-trip on a
    // deliberately revoked token, and NOT flagged as an expired session.
    expect(calls.refresh).toBe(0);
    expect(coordinator.getSnapshot()).toBe(false);
    expect(coordinator.wasSessionExpired()).toBe(false);
    expect(notifications).toBeGreaterThan(0);
  });

  it('REFRESH REJECTION: a throwing refresh rejects all joiners, preserves tokens, and clears inFlight', async () => {
    const refreshImpl = vi.fn(() => {
      throw new Error('network down');
    });
    const { client, calls } = createFakeAuthClient({ refresh: refreshImpl });
    const storage = createFakeStorage(pairA);
    const coordinator = createCoordinator({ authClient: client, storage, locks: createFakeLocks() });

    const settled = await Promise.allSettled([
      coordinator.refresh(),
      coordinator.refresh(),
      coordinator.refresh(),
    ]);

    // Every concurrent joiner rejects — the failure is not swallowed.
    expect(settled.every((r) => r.status === 'rejected')).toBe(true);
    // One shared server call for the single flight.
    expect(calls.refresh).toBe(1);
    // A network failure is NOT terminal: tokens preserved, session not expired.
    expect(storage.read()).toEqual(pairA);
    expect(coordinator.wasSessionExpired()).toBe(false);

    // inFlight was cleared: a subsequent refresh starts a NEW flight (hits the server again).
    await expect(coordinator.refresh()).rejects.toThrow();
    expect(calls.refresh).toBe(2);
  });
});

describe('coordinator.refresh — terminal failure', () => {
  it('clears the pair, flips the snapshot, notifies, and returns false', async () => {
    const { client } = createFakeAuthClient({ refresh: () => fail(401) });
    const storage = createFakeStorage(pairA);
    const coordinator = createCoordinator({ authClient: client, storage, locks: createFakeLocks() });

    let notifications = 0;
    coordinator.subscribe(() => {
      notifications += 1;
    });

    const result = await coordinator.refresh();

    expect(result).toBe(false);
    expect(storage.read()).toBeNull();
    expect(coordinator.getSnapshot()).toBe(false);
    expect(coordinator.wasSessionExpired()).toBe(true);
    expect(notifications).toBeGreaterThan(0);
  });
});

describe('coordinator.authFetch — 401 -> refresh -> retry', () => {
  it('retries once with the rotated bearer after a single refresh', async () => {
    const { client, calls } = createFakeAuthClient({ refresh: () => ok(pairB) });
    const storage = createFakeStorage(pairA);
    const { impl, requests } = createFakeFetch([
      new Response(null, { status: 401 }),
      new Response(null, { status: 200 }),
    ]);
    const coordinator = createCoordinator({
      authClient: client,
      storage,
      locks: createFakeLocks(),
      fetchImpl: impl,
    });

    const response = await coordinator.authFetch(new Request('http://localhost:8010/users/me'));

    expect(response.status).toBe(200);
    expect(calls.refresh).toBe(1);
    expect(requests).toHaveLength(2);
    expect(requests[0].headers.get('Authorization')).toBe('Bearer accessA');
    expect(requests[1].headers.get('Authorization')).toBe('Bearer accessB');
  });

  it('BODY PRESERVATION: replays the retry carrying the identical request body', async () => {
    const { client } = createFakeAuthClient({ refresh: () => ok(pairB) });
    const storage = createFakeStorage(pairA);
    const { impl, requests } = createFakeFetch([
      new Response(null, { status: 401 }),
      new Response(null, { status: 200 }),
    ]);
    const coordinator = createCoordinator({
      authClient: client,
      storage,
      locks: createFakeLocks(),
      fetchImpl: impl,
    });

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
    // AM-7: the pre-bearer clone means the replayed POST still carries the body.
    expect(await requests[1].text()).toBe(body);
    expect(requests[1].headers.get('Authorization')).toBe('Bearer accessB');
  });

  it('LOOP GUARD: does not retry a second time when the replay also 401s', async () => {
    const { client, calls } = createFakeAuthClient({ refresh: () => ok(pairB) });
    const storage = createFakeStorage(pairA);
    const { impl, requests } = createFakeFetch([
      new Response(null, { status: 401 }),
      new Response(null, { status: 401 }),
    ]);
    const coordinator = createCoordinator({
      authClient: client,
      storage,
      locks: createFakeLocks(),
      fetchImpl: impl,
    });

    const response = await coordinator.authFetch(new Request('http://localhost:8010/users/me'));

    expect(response.status).toBe(401);
    expect(calls.refresh).toBe(1);
    // Exactly one original + one retry — no third request.
    expect(requests).toHaveLength(2);
  });

  it('EXCLUSION: a 401 on an /auth path never triggers a refresh', async () => {
    const refreshSpy = vi.fn(() => ok(pairB));
    const { client, calls } = createFakeAuthClient({ refresh: refreshSpy });
    const storage = createFakeStorage(pairA);
    const { impl, requests } = createFakeFetch([new Response(null, { status: 401 })]);
    const coordinator = createCoordinator({
      authClient: client,
      storage,
      locks: createFakeLocks(),
      fetchImpl: impl,
    });

    const response = await coordinator.authFetch(new Request('http://localhost:8010/auth/login'));

    expect(response.status).toBe(401);
    expect(calls.refresh).toBe(0);
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
  });
});
