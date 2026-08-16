// The give-up rule for the receipt poll, isolated as a pure function because it
// is used in TWO places that must agree: the query's `refetchInterval` (when to
// fire the next GET) and the flow hook's render-time derivation (whether the
// user is looking at "still reading" or at "this took too long"). If those two
// disagreed, the UI would either show a dead spinner forever or claim a timeout
// while requests were still in flight.
import type { components } from '@budget/api-client';

type ReceiptStatus = components['schemas']['ReceiptStatus'];

/** Gap between polls while the server is still working. */
export const POLL_INTERVAL_MS = 2_000;

/**
 * Client-side give-up. Deliberately SHORTER than the server's parse timeout
 * (D10/D12: there is no server timeout endpoint, this is purely a UX budget), so
 * a slow-but-succeeding parse can land in `timedout`; retrying re-POSTs /parse
 * and the 409 ALREADY_PARSED/PROCESSING arms resume cleanly.
 */
export const POLL_DEADLINE_MS = 60_000;

/**
 * @param status  last known receipt status; `undefined` while no response has
 *                been seen yet (keep polling — nothing is known yet).
 * @param elapsedMs time since polling started.
 * @returns the delay before the next poll, or `false` to stop.
 */
export function pollInterval(
  status: ReceiptStatus | undefined,
  elapsedMs: number,
): number | false {
  if (status === 'parsed' || status === 'failed') return false;
  if (elapsedMs >= POLL_DEADLINE_MS) return false;
  return POLL_INTERVAL_MS;
}
