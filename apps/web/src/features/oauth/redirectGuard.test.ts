import { describe, expect, it } from 'vitest';

import { isAllowedRedirect } from './redirectGuard';

// Eight cases, each a DIFFERENT accept shape or a different reason to refuse —
// the three refusals in particular are the ones a plain `startsWith`/`includes`
// check would wave through.
describe('isAllowedRedirect', () => {
  it('accepts the claude.ai callback with the code and state the server appended', () => {
    expect(
      isAllowedRedirect('https://claude.ai/api/mcp/auth_callback?code=abc&state=xyz'),
    ).toBe(true);
  });

  it('accepts a bare loopback listener', () => {
    expect(isAllowedRedirect('http://localhost/')).toBe(true);
  });

  it('accepts a loopback listener on its own port and path', () => {
    expect(isAllowedRedirect('http://localhost:49152/oauth/callback?code=abc')).toBe(true);
  });

  it('accepts the numeric loopback host', () => {
    expect(isAllowedRedirect('http://127.0.0.1:3000/callback')).toBe(true);
  });

  it('refuses a look-alike host: the ORIGIN is compared, not a suffix', () => {
    expect(isAllowedRedirect('https://claude.ai.evil.com/api/mcp/auth_callback?code=abc')).toBe(
      false,
    );
  });

  it('refuses claude.ai on another port (the port is part of the origin)', () => {
    expect(isAllowedRedirect('https://claude.ai:8443/api/mcp/auth_callback')).toBe(false);
  });

  it('refuses a protocol-relative address (no base => it does not parse)', () => {
    expect(isAllowedRedirect('//claude.ai/api/mcp/auth_callback')).toBe(false);
  });

  it('refuses a javascript: URL (parses fine, is not http(s))', () => {
    expect(isAllowedRedirect('javascript:alert(1)')).toBe(false);
  });
});
