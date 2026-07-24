import { describe, expect, it } from 'vitest';

import { DEFAULT_AUTHED_ROUTE, safeNextRoute } from './next';

describe('safeNextRoute — return-route guard (O6)', () => {
  it('passes a valid local absolute route unchanged', () => {
    expect(safeNextRoute('/categories')).toBe('/categories');
  });

  it('falls back to the default for a protocol-relative route (//host)', () => {
    expect(safeNextRoute('//evil.com')).toBe(DEFAULT_AUTHED_ROUTE);
  });

  it('falls back to the default for an absolute-scheme URL', () => {
    expect(safeNextRoute('https://evil.com')).toBe(DEFAULT_AUTHED_ROUTE);
  });

  it('falls back to the default for a backslash bypass (/\\evil.com)', () => {
    expect(safeNextRoute('/\\evil.com')).toBe(DEFAULT_AUTHED_ROUTE);
  });

  it('falls back to the default for null / undefined', () => {
    expect(safeNextRoute(null)).toBe(DEFAULT_AUTHED_ROUTE);
    expect(safeNextRoute(undefined)).toBe(DEFAULT_AUTHED_ROUTE);
  });

  it('falls back to the default for a repeated param (string[]) instead of throwing', () => {
    // useLocalSearchParams yields an array when `next` repeats (`?next=/a&next=/b`).
    // An array is truthy but has no .startsWith, so the pre-guard must catch it before
    // it can throw a TypeError from a crafted deep link.
    expect(safeNextRoute(['/categories', '/transactions'])).toBe(DEFAULT_AUTHED_ROUTE);
  });
});
