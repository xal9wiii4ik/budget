// Stats data layer (catch-up 3, line A) — the ONE query mobile needs, trimmed from
// web's data/stats.ts.
//
// The whole /stats SCREEN is deliberately absent from this client (no chart library,
// and the tabs are full). What is here is the single number the category screen puts
// above its list: the server's own total for that category over that period. Every
// figure on screen is a SERVER field — the client recomputes no money (D16).
//
// Web's monthly and top-merchants queries are NOT ported: nothing here reads them,
// and a data layer for a screen that does not exist is dead code with a cache key.
//
// Freshness comes from the blanket ['stats'] invalidation the three transaction
// mutations now fire (data/transactions.ts), not from polling, so the client's
// default staleTime is kept. `placeholderData: keepPreviousData` is web's rule too:
// stepping the period dims the number already on screen instead of flashing back to
// a skeleton — first load still shows one.
import type { components } from '@budget/api-client';
import { throwOnError } from '@budget/api-client';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { apiClient } from '../lib/api';
import { qk, type StatsPeriodQuery } from './queryKeys';

export type StatsSummaryRead = components['schemas']['StatsSummaryRead'];

export function useStatsSummary(period: StatsPeriodQuery) {
  return useQuery<StatsSummaryRead>({
    queryKey: qk.statsSummary(period),
    // The key member IS the wire query object, so a cached entry can never drift
    // from the request that filled it.
    queryFn: () => throwOnError(apiClient.GET('/stats/summary', { params: { query: period } })),
    placeholderData: keepPreviousData,
  });
}
