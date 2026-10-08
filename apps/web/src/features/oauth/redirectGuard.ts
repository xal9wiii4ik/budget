// The consent page's last line against an open redirect (mcp-remote, D6).
//
// The server composes `redirect_to` from the redirect_uri it STORED at
// /oauth/authorize (never from anything the browser sent), and DCR already
// refused every URI outside the two shapes below — so this check is
// belt-and-braces. It exists because the consequence of the server ever being
// wrong here is handing an authorization code to an attacker's address: a pure,
// tested predicate is cheap, and a refusal renders the "you can close this tab"
// arm instead of navigating.
//
// Deliberately NOT a suffix/`includes` test: `url.origin` is the scheme + host +
// port triple, so `https://claude.ai.evil.com/api/mcp/auth_callback` and
// `https://claude.ai:8443/api/mcp/auth_callback` are both rejected without any
// string surgery.

/** The ONE non-loopback callback Claude registers (architecture §D7). */
const CLAUDE_ORIGIN = 'https://claude.ai';
const CLAUDE_CALLBACK_PATH = '/api/mcp/auth_callback';

/**
 * Loopback hosts for a native client listening on this machine. `URL.hostname`
 * strips the brackets from `[::1]`, so the bare form is what is compared; the
 * PORT is deliberately unconstrained (a loopback listener takes whatever port
 * the OS gave it — the same rule the server's own matcher uses).
 */
const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '::1'];

/**
 * Whether `window.location.replace` may be pointed at this address.
 *
 * `new URL(raw)` with NO base is what makes the protocol-relative and
 * path-relative cases fail closed: `//claude.ai/x`, `/path` and plain garbage
 * all throw, and `javascript:` / `data:` / `file:` parse but are not http(s).
 */
export function isAllowedRedirect(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') {
    return url.origin === CLAUDE_ORIGIN && url.pathname === CLAUDE_CALLBACK_PATH;
  }
  // Plaintext is acceptable ONLY for a listener on this machine; everything that
  // is neither https nor http (javascript:, data:, file:) is refused outright.
  if (url.protocol !== 'http:') return false;
  return LOOPBACK_HOSTS.includes(url.hostname);
}
