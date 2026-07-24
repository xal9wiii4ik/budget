// Return-route validator (O6) — the RN analogue of web's safeNextPath. The guard
// preserves the intended route in a typed `next` param; login validates it here
// before navigating so a crafted deep link can't bounce the user to a foreign
// scheme/host. Must be a LOCAL in-app absolute path (single leading slash).
export const DEFAULT_AUTHED_ROUTE = '/transactions';

/**
 * Validate a `next` return-to route. Must be a LOCAL absolute path (single leading
 * slash, not `//host`, no backslash, no scheme). Anything else falls back to the
 * default protected route.
 */
export function safeNextRoute(next: string | string[] | null | undefined): string {
  // useLocalSearchParams yields `string[]` when a param repeats (`?next=/a&next=/b`);
  // the caller's type annotation hides this from tsc. An array is truthy AND has no
  // .startsWith, so an unguarded check would throw a red-screen TypeError from a
  // crafted link — in the exact validator whose job is deep-link safety (O6). Reject
  // anything that isn't a plain string up front.
  if (typeof next !== 'string') return DEFAULT_AUTHED_ROUTE;
  if (!next) return DEFAULT_AUTHED_ROUTE;
  // Reject `\` too: it can be normalised to `/`, so `/\evil.com` could resolve
  // off-app — the leading-slash check alone is not enough.
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\')) {
    return DEFAULT_AUTHED_ROUTE;
  }
  return next;
}
