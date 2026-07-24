// Two-client wiring (O1). The plain authClient runs the /auth endpoints with no
// bearer and no 401->refresh retry, making the "auth endpoints never trigger
// refresh" exclusion STRUCTURAL. The protected apiClient routes every request
// through the coordinator's authFetch (bearer + single silent 401->refresh->retry).
// The coordinator is wired here with the real secure-store adapter (O2) and the
// AppState resume subscription (O5) — the two platform seams.
import { createApiClient } from '@budget/api-client';

import { createCoordinator } from '../auth/coordinator';
import { subscribeAppStateResume } from '../auth/resume';
import { createSecureStoreTokenStorage } from '../auth/secureStore';
import { resolveBaseUrl } from './baseUrl';

const baseUrl = resolveBaseUrl();

export const authClient = createApiClient({ baseUrl });

export const coordinator = createCoordinator({
  authClient,
  storage: createSecureStoreTokenStorage(),
  subscribeResume: subscribeAppStateResume,
});

export const apiClient = createApiClient({
  baseUrl,
  fetch: coordinator.authFetch,
});
