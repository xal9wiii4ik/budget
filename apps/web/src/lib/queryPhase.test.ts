import { describe, expect, it } from 'vitest';

import { queryPhase } from './queryPhase';

describe('queryPhase', () => {
  // The whole point of the module: both of these report `isPending`, and the
  // shipped screens rendered the same eternal skeleton for both.
  it('separates a paused query from one that is actually fetching', () => {
    expect(queryPhase({ status: 'pending', fetchStatus: 'paused' })).toBe('unreachable');
    expect(queryPhase({ status: 'pending', fetchStatus: 'fetching' })).toBe('loading');
  });

  it('treats a pending, idle query as loading', () => {
    expect(queryPhase({ status: 'pending', fetchStatus: 'idle' })).toBe('loading');
  });

  it('reports error and success', () => {
    expect(queryPhase({ status: 'error', fetchStatus: 'idle' })).toBe('error');
    expect(queryPhase({ status: 'success', fetchStatus: 'idle' })).toBe('ready');
  });

  // A period step keeps the previous numbers dimmed on screen; if placeholder data
  // reported 'loading' the screen would flash skeletons on every step.
  it('keeps placeholder data ready rather than loading', () => {
    expect(
      queryPhase({ status: 'success', fetchStatus: 'fetching', isPlaceholderData: true }),
    ).toBe('ready');
  });

  // A background refetch of already-loaded data must not blank the screen.
  it('stays ready while a successful query refetches', () => {
    expect(queryPhase({ status: 'success', fetchStatus: 'fetching' })).toBe('ready');
  });
});
