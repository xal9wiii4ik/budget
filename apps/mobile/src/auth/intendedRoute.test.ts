import { beforeEach, describe, expect, it } from 'vitest';

import {
  captureIntendedRoute,
  intendedRouteFromNavigationState,
  releaseIntendedRoute,
  type NavigationStateLike,
} from './intendedRoute';

// The `rootState` fixtures below are VERBATIM `useRootNavigationState()` payloads
// logged from the `(app)` guard on the simulator (iPhone 17 Pro / iOS 26.5, Expo Go,
// expo-router 57.0.8) while reproducing TC-8. Do not "tidy" them: the excess fields
// (`key`, `stale`, `routeNames`, …) and the odd shapes ARE the evidence — the first
// fix attempt failed on-device precisely because it was written against invented
// shapes. TC-8 in the mobile QA checklist covers the live wiring.

const APP_GROUP = '(app)';

/** COLD deep link to /categories while logged out: the whole chain is the stale
 * state getStateFromPath built from the URL — no `index` anywhere. */
// Captured verbatim from the device; `usePathname()` read `/` in this render.
const COLD_DEEP_LINK = JSON.parse(`
  {
    "stale": false,
    "type": "stack",
    "key": "stack-yp0YOKRnwDJoUmTcamhR4",
    "index": 0,
    "routeNames": [
      "__root",
      "+not-found",
      "_sitemap"
    ],
    "routes": [
      {
        "name": "__root",
        "state": {
          "routes": [
            {
              "name": "(app)",
              "state": {
                "routes": [
                  {
                    "name": "(tabs)",
                    "state": {
                      "routes": [
                        {
                          "name": "categories",
                          "path": "/categories"
                        }
                      ],
                      "stale": true
                    }
                  }
                ],
                "stale": true
              }
            }
          ],
          "stale": true
        },
        "key": "__root-rNkbT0ac3j-J888F3A-sG"
      }
    ],
    "preloadedRoutes": []
  }
`) as NavigationStateLike;

/** The render right after the guard swapped its `<Stack>` for the redirect: `(app)`
 * is still in the parent stack but its children are unmounted, so NOTHING in the state
 * says where the user was going. This render is what broke the first fix attempt —
 * it resolved to `/` (=> index => /transactions) and, because `<Redirect>` re-issues
 * its `router.replace` on every render, that last write won. */
// Captured verbatim from the device; `usePathname()` read `/` in this render.
const REDIRECT_TEARDOWN = JSON.parse(`
  {
    "stale": false,
    "type": "stack",
    "key": "stack-gchUs7J0uH_n6LLLyUhJq",
    "index": 0,
    "routeNames": [
      "__root",
      "+not-found",
      "_sitemap"
    ],
    "routes": [
      {
        "name": "__root",
        "state": {
          "stale": false,
          "type": "stack",
          "key": "stack-GOvxGrIISo4XREcYjWMnS",
          "index": 0,
          "routeNames": [
            "index",
            "(app)",
            "(auth)"
          ],
          "routes": [
            {
              "name": "(app)",
              "key": "(app)-9WG-Vsry3XE9bjj7UPenI"
            }
          ],
          "preloadedRoutes": []
        },
        "key": "__root-GbWE10kLr45iKy-aeNhtY"
      }
    ],
    "preloadedRoutes": []
  }
`) as NavigationStateLike;

/** WARM deep link to /categories while sitting on the login screen: the committed
 * state still holds the PREVIOUS screen ((auth)/login) because the NAVIGATE has not
 * been committed; the incoming target lives in `__root.params`. */
// Captured verbatim from the device; `usePathname()` read `/categories` in this render.
const WARM_DEEP_LINK = JSON.parse(`
  {
    "stale": false,
    "type": "stack",
    "key": "stack-yp0YOKRnwDJoUmTcamhR4",
    "index": 0,
    "routeNames": [
      "__root",
      "+not-found",
      "_sitemap"
    ],
    "routes": [
      {
        "name": "__root",
        "state": {
          "stale": false,
          "type": "stack",
          "key": "stack-3BwntylJToSA0kfBirXY1",
          "index": 0,
          "routeNames": [
            "index",
            "(app)",
            "(auth)"
          ],
          "routes": [
            {
              "key": "(auth)-IMj4YstuzB0aKGPfl6dVV",
              "name": "(auth)",
              "params": {
                "next": "/transactions",
                "screen": "login",
                "params": {
                  "next": "/transactions"
                }
              }
            }
          ],
          "preloadedRoutes": []
        },
        "key": "__root-rNkbT0ac3j-J888F3A-sG",
        "params": {
          "initial": true,
          "screen": "(app)",
          "params": {
            "pop": true,
            "initial": true,
            "screen": "(tabs)",
            "params": {
              "pop": true,
              "initial": true,
              "screen": "categories",
              "path": "categories"
            }
          },
          "pop": true
        }
      }
    ],
    "preloadedRoutes": []
  }
`) as NavigationStateLike;

/** COLD start with NO deep link: `(app)` has not mounted its child navigator, so its
 * target hangs off `params` rather than `state`. */
// Captured verbatim from the device; `usePathname()` read `/transactions` in this render.
const COLD_START_NO_DEEP_LINK = JSON.parse(`
  {
    "stale": false,
    "type": "stack",
    "key": "stack-ust2cFEhUjzEVuIJmq-Kl",
    "index": 0,
    "routeNames": [
      "__root",
      "+not-found",
      "_sitemap"
    ],
    "routes": [
      {
        "name": "__root",
        "state": {
          "stale": false,
          "type": "stack",
          "key": "stack-1Pfxco1E9pSb4x93rv7i2",
          "index": 0,
          "routeNames": [
            "index",
            "(app)",
            "(auth)"
          ],
          "routes": [
            {
              "key": "(app)-Bqg2Smw-41MP05ugnKP0f",
              "name": "(app)",
              "params": {
                "screen": "(tabs)",
                "params": {
                  "screen": "transactions",
                  "params": {}
                }
              }
            }
          ],
          "preloadedRoutes": []
        },
        "key": "__root-EabFi7yl_fZFfyCelDXuQ"
      }
    ],
    "preloadedRoutes": []
  }
`) as NavigationStateLike;

describe('intendedRouteFromNavigationState — deep-link `next` capture (TC-8)', () => {
  it('resolves a cold deep link from the stale state chain', () => {
    expect(intendedRouteFromNavigationState(COLD_DEEP_LINK, APP_GROUP)).toBe('/categories');
  });

  it('resolves a warm deep link from the pending navigate payload, not the committed screen', () => {
    // The committed chain leads to (auth)/login here — following it (the first fix
    // attempt) sent the user back to the login screen after signing in.
    expect(intendedRouteFromNavigationState(WARM_DEEP_LINK, APP_GROUP)).toBe('/categories');
  });

  it('resolves a cold start without a deep link to the default tab', () => {
    expect(intendedRouteFromNavigationState(COLD_START_NO_DEEP_LINK, APP_GROUP)).toBe(
      '/transactions',
    );
  });

  it('returns null — never `/` — for the teardown render that has nothing to resolve', () => {
    expect(intendedRouteFromNavigationState(REDIRECT_TEARDOWN, APP_GROUP)).toBeNull();
  });

  it('captures a modal so the layout can map it to its parent tab', () => {
    expect(
      intendedRouteFromNavigationState(
        {
          index: 0,
          routes: [
            {
              name: '__root',
              state: {
                index: 0,
                routes: [
                  {
                    name: '(app)',
                    state: {
                      index: 1,
                      routes: [
                        { name: '(tabs)', state: { index: 0, routes: [{ name: 'transactions' }] } },
                        { name: 'transaction-form', params: { id: 'tx-1' } },
                      ],
                    },
                  },
                ],
              },
            },
          ],
        },
        APP_GROUP,
      ),
    ).toBe('/transaction-form');
  });

  it('returns null when the focused chain leads outside the group and nothing is pending', () => {
    // Same shape as WARM_DEEP_LINK minus the `__root.params` payload: the guard is not
    // being mounted for anything, so `/login` must not become the return route.
    expect(
      intendedRouteFromNavigationState(
        {
          index: 0,
          routes: [
            {
              name: '__root',
              state: {
                index: 0,
                routes: [{ name: '(auth)', params: { screen: 'login', params: { next: '/' } } }],
              },
            },
          ],
        },
        APP_GROUP,
      ),
    ).toBeNull();
  });

  it('returns null for a generated route outside the app tree (+not-found)', () => {
    expect(
      intendedRouteFromNavigationState(
        { index: 1, routes: [{ name: '__root' }, { name: '+not-found' }] },
        APP_GROUP,
      ),
    ).toBeNull();
  });

  it('returns null for an unresolved dynamic segment rather than a literal /[id]', () => {
    expect(
      intendedRouteFromNavigationState(
        {
          index: 0,
          routes: [
            {
              name: '__root',
              state: {
                index: 0,
                routes: [
                  { name: '(app)', state: { routes: [{ name: 'receipts/[id]' }] } },
                ],
              },
            },
          ],
        },
        APP_GROUP,
      ),
    ).toBeNull();
  });

  it('returns null when there is no navigation state yet', () => {
    expect(intendedRouteFromNavigationState(undefined, APP_GROUP)).toBeNull();
  });
});

describe('captureIntendedRoute — surviving the redirect re-renders (TC-8)', () => {
  beforeEach(() => {
    releaseIntendedRoute();
  });

  it('keeps the resolved route through the teardown render that resolves nothing', () => {
    // The exact on-device sequence of guard renders for a deep link while logged out:
    // resolvable render -> teardown render -> post-redirect render. Every one of them
    // re-issues `router.replace`, so the LAST answer is the one login acts on.
    expect(captureIntendedRoute(COLD_DEEP_LINK, APP_GROUP)).toBe('/categories');
    expect(captureIntendedRoute(REDIRECT_TEARDOWN, APP_GROUP)).toBe('/categories');
    expect(captureIntendedRoute(WARM_DEEP_LINK, APP_GROUP)).toBe('/categories');
  });

  it('takes the newer route when a later render resolves one', () => {
    // Logging out captures the default tab; a deep link arriving while the user is
    // still on the login screen must win over it.
    expect(captureIntendedRoute(COLD_START_NO_DEEP_LINK, APP_GROUP)).toBe('/transactions');
    expect(captureIntendedRoute(WARM_DEEP_LINK, APP_GROUP)).toBe('/categories');
  });

  it('forgets the captured route once released, so a later expiry starts fresh', () => {
    captureIntendedRoute(WARM_DEEP_LINK, APP_GROUP);
    releaseIntendedRoute();
    expect(captureIntendedRoute(REDIRECT_TEARDOWN, APP_GROUP)).toBeNull();
  });
});
