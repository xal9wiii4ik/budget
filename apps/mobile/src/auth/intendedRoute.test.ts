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

/** DEFECT O-1, render 1 of 2. Logging out from the Categories TAB of a live app:
 * the tree is still whole, so the committed chain (`(app)` -> `(tabs)` -> the tab at
 * `index`) is the answer, and it is `/categories`. */
const LOGOUT_FROM_CATEGORIES = JSON.parse(`
  {
    "stale": false,
    "type": "stack",
    "key": "stack-14Oe-Gl8GAhmEJiiHRWbN",
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
          "key": "stack-dabtpA9G0F1tQGmzc5-Ec",
          "index": 1,
          "routeNames": [
            "index",
            "(app)",
            "(auth)"
          ],
          "routes": [
            {
              "key": "(auth)-Lo9YH0Oscjggf4U-odJvi",
              "name": "(auth)",
              "params": {
                "next": "/transactions",
                "reason": "expired",
                "screen": "login",
                "params": {
                  "next": "/transactions",
                  "reason": "expired"
                }
              }
            },
            {
              "key": "(app)--Bgj4viihDlEUNOrIgtYn",
              "name": "(app)",
              "params": {
                "screen": "(tabs)",
                "params": {
                  "screen": "accounts",
                  "params": {}
                }
              },
              "state": {
                "stale": false,
                "type": "stack",
                "key": "stack-yyha_wjD0oxYUzGln3AQo",
                "index": 0,
                "routeNames": [
                  "(tabs)",
                  "transaction-form",
                  "transfer-form",
                  "category-form",
                  "account-form",
                  "category-transactions",
                  "recurring",
                  "recurring-form",
                  "goal-plan",
                  "goal-form",
                  "goal-cost-form",
                  "goal-item-form",
                  "contribution-form"
                ],
                "routes": [
                  {
                    "name": "(tabs)",
                    "params": {
                      "screen": "accounts",
                      "params": {}
                    },
                    "key": "(tabs)-xBJvhY_yZaKnjoCW0JVJR",
                    "state": {
                      "stale": false,
                      "type": "tab",
                      "key": "tab-YDG5Gle_kD_8g9JolknBM-replace",
                      "index": 1,
                      "routeNames": [
                        "transactions",
                        "categories",
                        "accounts",
                        "goals",
                        "more"
                      ],
                      "history": [
                        {
                          "type": "route",
                          "key": "transactions-h4xFm2kCv-uCb6DIE77EH"
                        },
                        {
                          "type": "route",
                          "key": "categories-hMES52Gr8O85d1ytgA2o9"
                        }
                      ],
                      "routes": [
                        {
                          "name": "transactions",
                          "key": "transactions-h4xFm2kCv-uCb6DIE77EH"
                        },
                        {
                          "name": "categories",
                          "key": "categories-hMES52Gr8O85d1ytgA2o9"
                        },
                        {
                          "name": "accounts",
                          "params": {},
                          "key": "accounts-wSujGmpshoNdmOJPEVW6F"
                        },
                        {
                          "name": "goals",
                          "key": "goals-b-BSaQgQjBILzLjFHQbst"
                        },
                        {
                          "name": "more",
                          "key": "more-g9ir8AQ4x-IOfHw9M_mxn"
                        }
                      ],
                      "preloadedRouteKeys": []
                    }
                  }
                ],
                "preloadedRoutes": []
              }
            }
          ],
          "preloadedRoutes": []
        },
        "key": "__root-mODTtd4pbHkzniQMYkGwM",
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
              "screen": "accounts",
              "path": "accounts"
            }
          },
          "pop": true
        }
      }
    ],
    "preloadedRoutes": []
  }
`) as NavigationStateLike;

/** DEFECT O-1, render 2 of 2 — THE defect. The same logout, one render later: the
 * group's children are gone and the `(app)` route is left with nothing but its own
 * `params`, which are the payload of the navigate that CREATED it (a `--/accounts`
 * deep link, two screens and one login ago). Nothing distinguishes them from the
 * cold-start arm's params, where the very same shape IS the answer — which is why
 * this state resolves `/accounts` below, and why the fix is the latch, not the walk. */
const LOGOUT_TEARDOWN_STALE_PARAMS = JSON.parse(`
  {
    "stale": false,
    "type": "stack",
    "key": "stack-14Oe-Gl8GAhmEJiiHRWbN",
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
          "key": "stack-dabtpA9G0F1tQGmzc5-Ec",
          "index": 1,
          "routeNames": [
            "index",
            "(app)",
            "(auth)"
          ],
          "routes": [
            {
              "key": "(auth)-Lo9YH0Oscjggf4U-odJvi",
              "name": "(auth)",
              "params": {
                "next": "/transactions",
                "reason": "expired",
                "screen": "login",
                "params": {
                  "next": "/transactions",
                  "reason": "expired"
                }
              },
              "state": {
                "stale": false,
                "type": "stack",
                "key": "stack-zfYcinQIIvQ-5qqkVoMI3",
                "index": 0,
                "routeNames": [
                  "login",
                  "register"
                ],
                "preloadedRoutes": [],
                "routes": [
                  {
                    "key": "login-SDoVPSOmmHlzPD-Rr5sj-",
                    "name": "login",
                    "params": {
                      "next": "/transactions",
                      "reason": "expired"
                    }
                  }
                ]
              }
            },
            {
              "key": "(app)--Bgj4viihDlEUNOrIgtYn",
              "name": "(app)",
              "params": {
                "screen": "(tabs)",
                "params": {
                  "screen": "accounts",
                  "params": {}
                }
              }
            }
          ],
          "preloadedRoutes": []
        },
        "key": "__root-mODTtd4pbHkzniQMYkGwM",
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
              "screen": "accounts",
              "path": "accounts"
            }
          },
          "pop": true
        }
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

  it('cannot tell a torn-down group from a cold start, and says so (O-1)', () => {
    // Both renders of one logout. The live tree answers correctly; the teardown
    // render answers with the route that CREATED the group — a stale `/accounts`
    // that is structurally identical to the cold-start arm above. This is the
    // defect, pinned as a property of the STATE: no walk can separate the two, so
    // the guard's episode latch is what has to.
    expect(intendedRouteFromNavigationState(LOGOUT_FROM_CATEGORIES, APP_GROUP)).toBe(
      '/categories',
    );
    expect(
      intendedRouteFromNavigationState(LOGOUT_TEARDOWN_STALE_PARAMS, APP_GROUP),
    ).toBe('/accounts');
  });
});

describe('captureIntendedRoute — surviving the redirect re-renders (TC-8)', () => {
  // The guard's per-mount episode token (app/(app)/_layout.tsx). A test that means
  // "the guard remounted" makes a new one.
  let episode: object;

  beforeEach(() => {
    releaseIntendedRoute();
    episode = {};
  });

  it('keeps the resolved route through the teardown render that resolves nothing', () => {
    // The exact on-device sequence of guard renders for a deep link while logged out:
    // resolvable render -> teardown render -> post-redirect render. Every one of them
    // re-issues `router.replace`, so every one of them has to answer the same thing.
    expect(captureIntendedRoute(COLD_DEEP_LINK, APP_GROUP, episode)).toBe('/categories');
    expect(captureIntendedRoute(REDIRECT_TEARDOWN, APP_GROUP, episode)).toBe('/categories');
    expect(captureIntendedRoute(WARM_DEEP_LINK, APP_GROUP, episode)).toBe('/categories');
  });

  it('keeps the FIRST answer when a later render resolves a stale one (O-1)', () => {
    // The on-device sequence of a logout from the Categories tab. Before the fix the
    // second render overwrote `/categories` with the stale `/accounts` and the login
    // screen carried a route from a session that had ended two logins earlier.
    expect(captureIntendedRoute(LOGOUT_FROM_CATEGORIES, APP_GROUP, episode)).toBe('/categories');
    expect(captureIntendedRoute(LOGOUT_TEARDOWN_STALE_PARAMS, APP_GROUP, episode)).toBe(
      '/categories',
    );
  });

  it('lets a later navigation win once the guard remounts (a new episode)', () => {
    // Logging out captures the tab the user was on; a deep link arriving while they
    // sit on the login screen must win over it. It does, because the `(app)` group is
    // unmounted at that point (the device capture of the warm arm holds no `(app)`
    // route at all), so that navigation MOUNTS the layout — a fresh episode token,
    // which is what the `{}` below stands for.
    expect(captureIntendedRoute(COLD_START_NO_DEEP_LINK, APP_GROUP, episode)).toBe(
      '/transactions',
    );
    expect(captureIntendedRoute(WARM_DEEP_LINK, APP_GROUP, {})).toBe('/categories');
  });

  it('forgets the captured route once released, so a later expiry starts fresh', () => {
    captureIntendedRoute(WARM_DEEP_LINK, APP_GROUP, episode);
    releaseIntendedRoute();
    expect(captureIntendedRoute(REDIRECT_TEARDOWN, APP_GROUP, episode)).toBeNull();
  });
});
