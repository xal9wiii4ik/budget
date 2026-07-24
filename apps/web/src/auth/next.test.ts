import { describe, expect, it } from 'vitest';

import { DEFAULT_AUTHED_PATH, safeNextPath } from './next';

describe('safeNextPath — open-redirect guard', () => {
  it('passes a valid local absolute path unchanged', () => {
    expect(safeNextPath('/transactions?range=month')).toBe('/transactions?range=month');
  });

  it('falls back to the default for a protocol-relative URL (//host)', () => {
    expect(safeNextPath('//evil.com')).toBe(DEFAULT_AUTHED_PATH);
  });

  it('falls back to the default for an absolute-scheme URL', () => {
    expect(safeNextPath('https://evil.com')).toBe(DEFAULT_AUTHED_PATH);
  });

  it('falls back to the default for a backslash bypass (/\\evil.com)', () => {
    // WHATWG URL resolution treats `\` as `/`, so this would resolve cross-origin.
    expect(safeNextPath('/\\evil.com')).toBe(DEFAULT_AUTHED_PATH);
  });

  it('falls back to the default when a %5C-decoded backslash arrives', () => {
    // A router that percent-decodes `%5C` hands us a literal backslash.
    expect(safeNextPath(decodeURIComponent('/%5Cevil.com'))).toBe(DEFAULT_AUTHED_PATH);
  });

  it('falls back to the default for null', () => {
    expect(safeNextPath(null)).toBe(DEFAULT_AUTHED_PATH);
  });
});
