import type { components } from '@budget/api-client';

import type { StatsSummaryRead } from '../../data/stats';
import type { StatsPeriodQuery } from '../../data/queryKeys';
import type { TxWindowPeriod } from '../transactions/txWindow';

type CategoryRead = components['schemas']['CategoryRead'];

/**
 * The window the category modal is showing — the shared drill-down period
 * (features/transactions/txWindow.ts), named here because everything below is
 * about what /stats/summary can say about it.
 *
 * All-time is absent from that union for this modal's own reason: the headline
 * number is a SERVER total from `/stats/summary`, whose period grammar
 * (StatsPeriodQuery) has no all-time unit — so offering the mode would mean a
 * list with no total to head it, or a total computed here, which is the money
 * arithmetic this client never does.
 */
export type CategoryPeriod = TxWindowPeriod;

/** The same window, in the wire grammar `/stats/summary` takes (server D5). */
export function categoryStatsPeriod(period: CategoryPeriod): StatsPeriodQuery {
  switch (period.kind) {
    case 'month':
      return { period: 'month', month: period.month };
    case 'custom':
      return { period: 'custom', from: period.from, to: period.to };
  }
}

/**
 * How much this category accounts for in the period, as `total_minor` in the
 * summary's OWN currency — a field of the response, chosen by id, never a sum
 * computed here (D16: the client recomputes no money).
 *
 * The match is on `category_id` AND `kind`: `by_category` is keyed by both, and
 * one category id legitimately appears twice when a refund books income against
 * an expense category — taking the first id match would then show the refund's
 * total as the category's spend. The category's own kind is the row that belongs
 * to it.
 *
 * No row at all means the category has nothing in this period, which is exactly
 * 0 — the server omits empty buckets rather than sending zeroes.
 */
export function categoryPeriodTotal(
  summary: StatsSummaryRead,
  categoryId: string,
  kind: CategoryRead['kind'],
): number {
  const row = summary.by_category.find(
    (item) => item.category_id === categoryId && item.kind === kind,
  );
  return row?.total_minor ?? 0;
}
