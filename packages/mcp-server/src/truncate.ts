/**
 * Response size guard (architecture §5): a 3000-row transaction dump would burn
 * the model's context and answer nothing. Over the threshold we cut the longest
 * array from the TAIL and say so — a silent cut would let the model claim a
 * total it never saw.
 */

/** Starting value from architecture §5; tune after real traffic, not in theory. */
export const THRESHOLD_BYTES = 50_000;

export const TRUNCATION_NOTE = 'response truncated, narrow the query (dates/category/limit)';

export interface TruncationMarker {
  readonly shown: number;
  readonly total: number;
  readonly note: string;
}

export function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

interface ArrayTarget {
  /** `undefined` when the response itself is the array. */
  readonly key: string | undefined;
  readonly array: readonly unknown[];
}

function findLongestArray(value: unknown): ArrayTarget | undefined {
  if (Array.isArray(value)) return { key: undefined, array: value };
  if (typeof value !== 'object' || value === null) return undefined;
  let best: ArrayTarget | undefined;
  for (const [key, entry] of Object.entries(value)) {
    if (Array.isArray(entry) && (best === undefined || entry.length > best.array.length)) {
      best = { key, array: entry };
    }
  }
  return best;
}

function cut(value: unknown, target: ArrayTarget, shown: number): unknown {
  const marker: TruncationMarker = { shown, total: target.array.length, note: TRUNCATION_NOTE };
  const items = target.array.slice(0, shown);
  // A bare array has nowhere to carry the marker, so it becomes {items, _truncated}.
  if (target.key === undefined) return { items, _truncated: marker };
  return { ...(value as Record<string, unknown>), [target.key]: items, _truncated: marker };
}

/**
 * Halve the longest array from the tail until the payload fits.
 *
 * One element is ALWAYS kept: if a single row is still over the threshold, the
 * caller gets that row with an honest marker instead of an empty shell.
 */
export function truncateResponse(value: unknown, thresholdBytes: number = THRESHOLD_BYTES): unknown {
  if (byteLength(value) <= thresholdBytes) return value;

  const target = findLongestArray(value);
  if (target === undefined || target.array.length <= 1) return value;

  let shown = target.array.length;
  let result: unknown;
  do {
    shown = Math.max(1, Math.floor(shown / 2));
    result = cut(value, target, shown);
  } while (shown > 1 && byteLength(result) > thresholdBytes);
  return result;
}
