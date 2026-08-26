// Upcoming plan deadlines — `GET /goals/upcoming` (goal-planner W2, server B2).
//
// The rows CROSS goals, so unlike the per-goal tree there is no single currency
// echoed once per response: every row carries its own (`currency` for the item's
// amount, `goal_currency` for the goal-denominated figures). Nothing here — and
// nothing in the widget — sums across them (AM-5 / D12).
//
// Read-only family. It is refreshed by other people's writes, never its own:
// plan writes invalidate `['goals','upcoming']` explicitly (data/goalItems.ts),
// and a transaction write that touches a plan invalidates the bare `['goals']`
// prefix (data/transactions.ts).
import type { components } from '@budget/api-client';
import { useQuery } from '@tanstack/react-query';

import { apiClient } from '../lib/api';
import { ApiError } from '../lib/query';
import { qk } from './queryKeys';

export type UpcomingDeadlineRead = components['schemas']['UpcomingDeadlineRead'];
export type UpcomingDeadlineList = components['schemas']['UpcomingDeadlineList'];

/** The contract default (`days` 1–90, default 30). One caller, no control yet. */
export const GOAL_DEADLINE_DAYS = 30;

/**
 * `null` means "this API has no such endpoint" — see the 404 arm below. Every
 * other outcome is the ordinary `UpcomingDeadlineList`.
 */
async function fetchGoalDeadlines(days: number): Promise<UpcomingDeadlineList | null> {
  const { data, error, response } = await apiClient.GET('/goals/upcoming', {
    params: { query: { days } },
  });
  // TEMPORARY(B2-deploy): the endpoint ships in this scope's contract, so a 404
  // here can only mean the API instance in front of this build predates it. The
  // widget then renders NOTHING rather than an error with a Retry button that
  // cannot succeed — /transactions is somebody else's screen and must not carry
  // a permanent red box because of a deployment lag. Remove this arm once the
  // API is deployed; every other status stays an honest error.
  if (response.status === 404) return null;
  if (!response.ok || error !== undefined || data === undefined) {
    throw new ApiError(response.status, error);
  }
  return data;
}

export function useGoalDeadlines(days: number = GOAL_DEADLINE_DAYS) {
  return useQuery<UpcomingDeadlineList | null>({
    queryKey: qk.goalsUpcoming(days),
    queryFn: () => fetchGoalDeadlines(days),
  });
}
