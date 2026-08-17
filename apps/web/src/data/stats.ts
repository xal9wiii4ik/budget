// Stats data layer (4.2 W1/W2). Three read-only queries, no mutations, no cache
// patching: every number on the /stats screen is a SERVER field (D16 — the client
// recomputes nothing). Freshness comes from the blanket ['stats'] invalidation the
// three transaction mutations fire (data/transactions.ts, WS-2), not from polling,
// so the default 30 s staleTime is kept.
//
// All three use `placeholderData: keepPreviousData` (the useGoals precedent):
// stepping the period dims the numbers already on screen instead of flashing the
// whole page back to skeletons. First load still shows the skeletons.
//
// The query KEY member is the wire query object itself (queryKeys.ts), so a cached
// entry can never drift from the request that filled it.
import type { components } from '@budget/api-client';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { apiClient } from '../lib/api';
import { throwOnError } from '../lib/query';
import { qk, type StatsPeriodQuery } from './queryKeys';

export type StatsSummaryRead = components['schemas']['StatsSummaryRead'];
export type MonthlyRead = components['schemas']['MonthlyRead'];
export type MonthlyPoint = components['schemas']['MonthlyPoint'];
export type TopMerchantsRead = components['schemas']['TopMerchantsRead'];
export type MerchantTotalRead = components['schemas']['MerchantTotalRead'];
export type CategorySummary = components['schemas']['CategorySummary'];

/** Trailing-window sizes for /stats/monthly (server accepts 1..60). */
export const MONTHLY_WINDOWS = [6, 12, 24] as const;
export type MonthlyWindow = (typeof MONTHLY_WINDOWS)[number];
export const DEFAULT_MONTHLY_WINDOW: MonthlyWindow = 12;

/** Fixed for now — no selector until someone asks for one. */
export const TOP_MERCHANTS_LIMIT = 10;

export function useStatsSummary(period: StatsPeriodQuery) {
  return useQuery<StatsSummaryRead>({
    queryKey: qk.statsSummary(period),
    queryFn: () =>
      throwOnError(apiClient.GET('/stats/summary', { params: { query: period } })),
    placeholderData: keepPreviousData,
  });
}

/**
 * The trailing monthly window. NOT period-scoped (server D4: `months=N` ending at
 * the CURRENT, partial month) — which is exactly why the screen renders it as its
 * own "Last N months" section outside the period card (plan Disagreement 1).
 */
export function useStatsMonthly(months: number) {
  return useQuery<MonthlyRead>({
    queryKey: qk.statsMonthly(months),
    queryFn: () =>
      throwOnError(apiClient.GET('/stats/monthly', { params: { query: { months } } })),
    placeholderData: keepPreviousData,
  });
}

/** Expense-only by server design (no `kind` param) — the heading says so. */
export function useStatsTopMerchants(period: StatsPeriodQuery, limit: number) {
  return useQuery<TopMerchantsRead>({
    queryKey: qk.statsTopMerchants(period, limit),
    queryFn: () =>
      throwOnError(
        apiClient.GET('/stats/top-merchants', { params: { query: { ...period, limit } } }),
      ),
    placeholderData: keepPreviousData,
  });
}
