import { createApiClient } from '@budget/api-client';

import { createCoordinator } from '../auth/coordinator';
import { createWebLockManager } from '../auth/locks';
import { createLocalStorageTokenStorage } from '../auth/storage';

// Exported since 4.4: the advisor's streaming POST (packages/api-client/advisor.ts)
// is outside openapi-fetch and needs the same, ALREADY-VALIDATED base URL — it
// must not re-read import.meta.env and re-implement the guard below.
export const baseUrl = import.meta.env.VITE_API_URL;
if (!baseUrl) {
  throw new Error(
    'VITE_API_URL is not set. Copy apps/web/.env.example to apps/web/.env ' +
      '(or set the env var) before building/running the web client.',
  );
}

// Plain client for the /auth endpoints: no bearer, no 401->refresh retry. This
// makes the "auth endpoints must never trigger refresh" exclusion structural.
export const authClient = createApiClient({ baseUrl });

// The token/refresh coordinator owns auth client state (never TanStack Query).
export const coordinator = createCoordinator({
  authClient,
  storage: createLocalStorageTokenStorage(),
  locks: createWebLockManager(),
});

// Protected client: every request gets a bearer and a single silent
// 401->refresh->retry via the coordinator's fetch wrapper.
export const apiClient = createApiClient({
  baseUrl,
  fetch: coordinator.authFetch,
});
