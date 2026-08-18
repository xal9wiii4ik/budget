// Intended-route resolution for the protected guard (O6 / defect TC-8).
//
// WHY THIS EXISTS — `usePathname()` is the WRONG source inside the `(app)` group
// layout at redirect time. `usePathname()` reads expo-router's global router store
// (`store.routeInfo`), which is only written from the NavigationContainer's
// `onStateChange` callback, i.e. AFTER the commit. On a cold deep link into a
// protected route while logged out the store still holds `defaultRouteInfo`
// (pathname `'/'`), the guard captured `next=/`, and `app/index.tsx` redirected
// `/` -> `/transactions`: exactly the observed "lands on Transactions" symptom.
//
// The live navigation state is correct at that moment, because the `(app)` layout is
// only rendering BECAUSE the root navigator already resolved the deep link.
// `useRootNavigationState()` reads it through `navigation.getState()`, which serves
// the not-yet-committed state during render. So we walk that state ourselves.
//
// THE STATE HAS TWO CHAINS, and which one is authoritative differs per arm. These
// are verbatim runtime captures from the simulator (iPhone 17 Pro / expo-router
// 57.0.8), reproduced in intendedRoute.test.ts:
//
//   * COLD deep link — `__root.state` is a chain of `stale: true` sub-states built by
//     getStateFromPath: `__root -> (app) -> (tabs) -> categories`. The committed
//     chain IS the answer.
//   * COLD start without a deep link — `__root.state` reaches `(app)`, whose target
//     hangs off `params` instead: `{screen: '(tabs)', params: {screen: 'transactions'}}`.
//     A navigator that has not mounted carries its target in params, so the walk must
//     continue through the params tail.
//   * WARM deep link — `__root.state` still holds the PREVIOUS screen
//     (`(auth) -> login`, the login route the user is sitting on) because the NAVIGATE
//     has not been committed yet, while the fresh deep-link target sits in
//     `__root.params` as a nested `{screen, params}` payload. Following the focused
//     chain here yields `/login`; the params chain is the only correct source.
//
// Hence the rule: the guard renders for the `(app)` group, so the intended route is
// BY DEFINITION inside that group. Take the committed focused chain when it leads
// into the group; otherwise fall back to the pending navigate payload in the slot's
// params, which is precisely the not-yet-committed warm deep link. A chain that
// leads anywhere else is not this guard's business and resolves to null.

/** Structural view of a react-navigation state — only what the walk needs. */
export interface NavigationStateLike {
  index?: number | undefined;
  routes: readonly NavigationRouteLike[];
}

export interface NavigationRouteLike {
  name: string;
  params?: object | undefined;
  state?: NavigationStateLike | undefined;
}

// expo-router mounts the whole app tree under a single `__root` route of the
// container navigator; `+not-found` / `_sitemap` are its siblings.
const INTERNAL_SLOT_NAME = '__root';
const GROUP_SEGMENT = /^\(.*\)$/;
const DYNAMIC_SEGMENT = /^\[.*\]$/;

function focusedRoute(state: NavigationStateLike): NavigationRouteLike | undefined {
  // react-navigation's own findFocusedRoute convention. A live navigator state always
  // carries `index`; a stale state built by getStateFromPath does not, and there the
  // deep-link target is the LAST route (an initial route, when configured, is
  // prepended) — never index 0.
  const index = state.index ?? state.routes.length - 1;
  return state.routes[index];
}

/** Route names are usually one segment, but expo-router can emit `a/b` for a route
 * that has no intermediate layout — so always split before comparing segments. */
function segmentsOf(name: string): string[] {
  return (name.startsWith('/') ? name.slice(1) : name).split('/');
}

function isScreenParams(value: unknown): value is { screen: string; params?: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { screen?: unknown }).screen === 'string'
  );
}

/** The `{screen, params: {screen, …}}` payload of a navigate into nested navigators. */
function paramsChain(params: unknown): string[] {
  const segments: string[] = [];
  let tail: unknown = params;
  while (isScreenParams(tail)) {
    segments.push(...segmentsOf(tail.screen));
    tail = tail.params;
  }
  return segments;
}

/** The focused chain of the committed state, continued through the params tail of the
 * deepest route (a navigator that has not mounted yet holds its target in params). */
function committedChain(state: NavigationStateLike | undefined): string[] {
  const segments: string[] = [];
  let leaf: NavigationRouteLike | undefined;
  let current = state;
  while (current) {
    const route = focusedRoute(current);
    if (!route) break;
    leaf = route;
    segments.push(...segmentsOf(route.name));
    current = route.state;
  }
  if (leaf) segments.push(...paramsChain(leaf.params));
  return segments;
}

/**
 * Resolve the route the user actually asked for INSIDE `groupSegment` from the ROOT
 * navigation state (the one `useRootNavigationState()` returns).
 *
 * Returns `null` when the state cannot be resolved into a concrete route inside the
 * group: no state yet, a generated route (`+not-found` / `_sitemap`), a chain that
 * leads outside the group with no pending payload into it, an unresolved dynamic
 * segment, or — the render in which the guard's own `<Stack>` has just unmounted —
 * a group route whose children are already gone. Null means "no answer", never `/`:
 * `/` would silently mean `/transactions` via the index redirect, which is the very
 * bug TC-8 is about.
 */
export function intendedRouteFromNavigationState(
  rootState: NavigationStateLike | undefined,
  groupSegment: string,
): string | null {
  if (!rootState) return null;

  const slot = focusedRoute(rootState);
  if (!slot || slot.name !== INTERNAL_SLOT_NAME) return null;

  const committed = committedChain(slot.state);
  const chain = committed[0] === groupSegment ? committed : paramsChain(slot.params);
  if (chain[0] !== groupSegment) return null;

  const parts = chain.filter((part) => part !== '' && !GROUP_SEGMENT.test(part));
  if (parts.length === 0) return null;
  if (parts.some((part) => DYNAMIC_SEGMENT.test(part))) return null;
  return `/${parts.join('/')}`;
}

// The guard re-renders while it redirects, and `<Redirect>` re-issues its
// `router.replace` on EVERY render (its `useFocusEffect` callback is unmemoized), so
// the LAST render decides where login sends the user. The render right after the
// guard swaps its `<Stack>` for the redirect sees `(app)` with its children already
// unmounted — no chain, nothing to resolve — and would otherwise overwrite the good
// `next` with the fallback. So the last RESOLVED route is held here and unresolvable
// renders keep it. Module scope, not a ref: one root navigator per RN process (same
// reasoning as the auth coordinator singleton), and it survives the guard remounting.
let capturedRoute: string | null = null;

/** Resolve and remember the intended route; unresolvable states keep the last answer. */
export function captureIntendedRoute(
  rootState: NavigationStateLike | undefined,
  groupSegment: string,
): string | null {
  const resolved = intendedRouteFromNavigationState(rootState, groupSegment);
  if (resolved !== null) capturedRoute = resolved;
  return capturedRoute;
}

/** Forget the captured route — called once the user is authenticated, so a later
 * session expiry starts from the route they were actually on. */
export function releaseIntendedRoute(): void {
  capturedRoute = null;
}
