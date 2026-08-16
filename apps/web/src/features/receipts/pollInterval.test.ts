import { describe, expect, it } from 'vitest';

import { POLL_DEADLINE_MS, POLL_INTERVAL_MS, pollInterval } from './pollInterval';

describe('pollInterval', () => {
  it('keeps polling while the server is still working', () => {
    expect(pollInterval('pending', 0)).toBe(POLL_INTERVAL_MS);
    expect(pollInterval('processing', 10_000)).toBe(POLL_INTERVAL_MS);
    // No response seen yet: nothing is known, so this is NOT a reason to stop.
    expect(pollInterval(undefined, 10_000)).toBe(POLL_INTERVAL_MS);
  });

  it('stops on a terminal status even far inside the deadline', () => {
    expect(pollInterval('parsed', 0)).toBe(false);
    expect(pollInterval('failed', 0)).toBe(false);
  });

  it('gives up past the deadline while still processing', () => {
    // The contrast that matters: same status, opposite answer either side of the
    // boundary — this is the whole timeout behaviour.
    expect(pollInterval('processing', POLL_DEADLINE_MS - 1)).toBe(POLL_INTERVAL_MS);
    expect(pollInterval('processing', POLL_DEADLINE_MS)).toBe(false);
    expect(pollInterval('processing', POLL_DEADLINE_MS + 5_000)).toBe(false);
  });
});
