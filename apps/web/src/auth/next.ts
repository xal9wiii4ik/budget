export const DEFAULT_AUTHED_PATH = '/transactions';

/**
 * Validate a `?next=` return-to path. Must be a LOCAL absolute path (single
 * leading slash, not `//host`, no scheme) — an open-redirect guard. Anything
 * else falls back to the default protected route.
 */
export function safeNextPath(next: string | null): string {
  if (!next) return DEFAULT_AUTHED_PATH;
  // Reject `\` too: WHATWG URL resolution treats it as `/` for special schemes,
  // so `/\evil.com` would resolve cross-origin — the leading-slash check alone
  // is not enough.
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\')) {
    return DEFAULT_AUTHED_PATH;
  }
  return next;
}
