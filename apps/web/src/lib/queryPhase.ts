import type { FetchStatus, QueryStatus } from '@tanstack/react-query';

/**
 * The four states a screen has to render for a server read (WR-10 / P1, R5).
 *
 * TanStack's `isPending` covers TWO very different situations: a request that is
 * in flight, and a request the retryer refuses to start or continue (`fetchStatus:
 * 'paused'` — see `canStart()`/`canContinue()` in query-core's retryer). Branching
 * on `isPending ? skeleton : isError ? alert : …`, as every shipped screen did,
 * renders the second one as a skeleton that never resolves: measured on
 * query-core 5.101.4, a paused query is still `pending` after 12 s and its promise
 * never settles. Splitting the two here means "paused" can never again be
 * invisible — it gets its own actionable arm.
 */
export type QueryPhase = 'loading' | 'unreachable' | 'error' | 'ready';

export interface QueryPhaseInput {
  status: QueryStatus;
  fetchStatus: FetchStatus;
  /**
   * Present so a whole query result can be passed and so the placeholder case is
   * stated (and pinned by a test), but deliberately NOT branched on: with
   * `placeholderData`/`keepPreviousData` the status is already `'success'`, and a
   * period step must keep the previous numbers on screen, dimmed, rather than
   * flash back to skeletons.
   */
  isPlaceholderData?: boolean;
}

export function queryPhase(query: QueryPhaseInput): QueryPhase {
  if (query.status === 'error') return 'error';
  if (query.status === 'success') return 'ready';
  // pending: 'fetching' is a request in flight, 'idle' is one about to start
  // (disabled/lazy queries also land here); only 'paused' means the retryer will
  // not run until the browser changes its mind about the network or the tab.
  return query.fetchStatus === 'paused' ? 'unreachable' : 'loading';
}
