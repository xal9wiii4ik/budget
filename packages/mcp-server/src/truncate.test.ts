import { describe, expect, it } from 'vitest';

import { byteLength, THRESHOLD_BYTES, truncateResponse } from './truncate.js';

const row = (index: number): Record<string, unknown> => ({
  id: `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`,
  amount_minor: 1234 + index,
  merchant: 'A merchant name long enough to make these rows weigh something',
  occurred_at: '2026-08-19',
});

describe('truncateResponse', () => {
  it('leaves a response under the threshold completely untouched', () => {
    const payload = { items: [row(1), row(2)], total: 2 };

    // Same reference, no _truncated marker: below the threshold nothing is claimed.
    expect(truncateResponse(payload)).toBe(payload);
  });

  it('cuts the longest array from the tail and reports what it showed', () => {
    const items = Array.from({ length: 600 }, (_, index) => row(index));
    expect(byteLength({ items })).toBeGreaterThan(THRESHOLD_BYTES);

    const result = truncateResponse({ items, total: 600 }) as {
      items: unknown[];
      total: number;
      _truncated: { shown: number; total: number; note: string };
    };

    expect(byteLength(result)).toBeLessThanOrEqual(THRESHOLD_BYTES);
    expect(result.items[0]).toEqual(row(0)); // head kept, tail dropped
    expect(result._truncated.shown).toBe(result.items.length);
    expect(result._truncated.total).toBe(600);
    expect(result.total).toBe(600); // untouched sibling fields survive
  });

  it('keeps one element even when that element alone is over the threshold', () => {
    const fat = { note: 'x'.repeat(THRESHOLD_BYTES) };
    const result = truncateResponse({ items: [fat, fat, fat] }) as {
      items: unknown[];
      _truncated: { shown: number; total: number };
    };

    expect(result.items).toEqual([fat]);
    expect(result._truncated).toMatchObject({ shown: 1, total: 3 });
  });

  it('wraps a bare top-level array so the marker has somewhere to live', () => {
    const items = Array.from({ length: 600 }, (_, index) => row(index));

    const result = truncateResponse(items) as { items: unknown[]; _truncated: { total: number } };

    expect(result.items.length).toBeLessThan(600);
    expect(result._truncated.total).toBe(600);
  });
});
