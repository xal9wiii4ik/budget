// Upcoming plan deadlines — `GET /goals/upcoming` (mobile-catchup-3, line C).
//
// The rows CROSS goals, so unlike the per-goal tree there is no single currency
// echoed once per response: every row carries its own (`currency` for the item's
// amount, `goal_currency` for the goal-denominated figures). Nothing here — and
// nothing in the widget — sums across them.
//
// Read-only family. It is refreshed by other people's writes, never its own: plan
// writes invalidate `['goals','upcoming']` explicitly (data/goalItems.ts), and a
// transaction write that touches a plan invalidates the bare `['goals']` prefix
// (data/transactions.ts).
//
// DELIBERATELY WITHOUT web's TEMPORARY 404 -> null arm: that arm exists because a
// web build can be served in front of an older API. This client only ever talks to
// an API that already ships the endpoint, so a 404 here is a real failure and gets
// the honest error + retry every other read gets.
import type { components } from '@budget/api-client';
import { throwOnError } from '@budget/api-client';
import { useQuery } from '@tanstack/react-query';

import { apiClient } from '../lib/api';
import { qk } from './queryKeys';

export type UpcomingDeadlineRead = components['schemas']['UpcomingDeadlineRead'];
export type UpcomingDeadlineList = components['schemas']['UpcomingDeadlineList'];

/** The contract default (`days` 1–90, default 30). One caller, no control yet. */
export const GOAL_DEADLINE_DAYS = 30;

export function useGoalDeadlines(days: number = GOAL_DEADLINE_DAYS) {
  return useQuery<UpcomingDeadlineList>({
    queryKey: qk.goalsUpcoming(days),
    queryFn: () =>
      throwOnError(apiClient.GET('/goals/upcoming', { params: { query: { days } } })),
  });
}
