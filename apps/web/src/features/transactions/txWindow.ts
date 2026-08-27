// The "operations in a window" grammar, shared by every drill-down that opens a
// list over the screen it was opened from (the category window over /categories,
// the deposit window over /deposits).
//
// It exists so those windows and the /transactions screen describe ONE slice:
// the request filters and the "open all operations" link are built from the same
// two values (a filter and a period) by the same two functions. A second copy of
// either rule would mean a second cache entry for rows the page already has, or a
// link that lands on a different window than the one being looked at.
//
// No money is touched here — this module only decides which rows to ask for.
import { formatApiDate, formatMonthLabel } from '@budget/shared';

import type { TxListFilters } from '../../data/queryKeys';
import type { Translate } from '../../i18n/t';
import { rangeBounds, TX_LIST_LIMIT, type TxRangeMode } from './txFilters';

/**
 * The window a drill-down modal can show: the list's three range modes minus
 * all-time.
 *
 * All-time is out for the category window because its headline number is a
 * SERVER total from `/stats/summary`, whose period grammar has no all-time unit;
 * it stays out here because a windowed list with a period control is what these
 * modals are — the way to the whole history is the link to /transactions, which
 * has that mode.
 *
 * Derived from `TxRangeMode` rather than restated, so a fourth range mode lands
 * in this union too and fails the exhaustive switches below instead of silently
 * being ignored.
 */
export type TxWindowPeriod = Exclude<TxRangeMode, { kind: 'all' }>;

/**
 * What the window is filtered BY. One filter, never a combination: each of these
 * windows is opened from a row that IS the filter.
 *
 * The two arms carry the id under the name the thing goes by on its own screen,
 * and each one knows both how to ask the server for it (`txWindowFilters`) and
 * how to write it into a /transactions URL (`txWindowHref`) — so a new arm cannot
 * be added with only half a definition.
 */
export type TxWindowFilter =
  | { kind: 'category'; categoryId: string }
  // deposits: the id is the deposit's LEDGER account, never the deposit's own id
  // — that is what a transaction row points at, and the server matches EITHER leg
  // of a transfer, which is what makes top-ups and withdrawals one list.
  | { kind: 'account'; accountId: string };

/**
 * The list request / cache-key slice for a window — byte-for-byte the one
 * `txListFilters` builds on /transactions for the same filter and the same
 * period, so the modal and the full screen read ONE cache entry instead of
 * fetching the same rows twice.
 *
 * That identity is not a coincidence to be maintained by eye: `rangeBounds` and
 * `TX_LIST_LIMIT` are the /transactions screen's own, and txWindow.test.ts pins
 * the equality against `txListFilters(parseTxFilters(href))`.
 */
export function txWindowFilters(
  filter: TxWindowFilter,
  period: TxWindowPeriod,
): TxListFilters {
  return {
    ...rangeBounds(period),
    ...filterField(filter),
    limit: TX_LIST_LIMIT,
  };
}

/**
 * The "open all operations" link out of a window: the /transactions screen with
 * the SAME filter and the SAME period.
 *
 * The parameter names are the ones `parseTxFilters` reads (`account`,
 * `category`, `month`, `from`/`to`) — the page rebuilds the modal's window from
 * them, so the two screens show one slice, not two similar ones. `range=all` is
 * never written: no window has that mode.
 */
export function txWindowHref(filter: TxWindowFilter, period: TxWindowPeriod): string {
  const params = new URLSearchParams(
    filter.kind === 'category'
      ? { category: filter.categoryId }
      : { account: filter.accountId },
  );
  switch (period.kind) {
    case 'month':
      params.set('month', period.month);
      break;
    case 'custom':
      params.set('from', period.from);
      params.set('to', period.to);
      break;
  }
  return `/transactions?${params.toString()}`;
}

/**
 * The window in words — a month label, or "1 Aug – 15 Aug" for a custom period.
 * Language-free by the i18n rule: `t` and `locale` come from the component, so
 * this stays a pure function of its inputs.
 */
export function txWindowPeriodLabel(
  period: TxWindowPeriod,
  t: Translate,
  locale: string,
): string {
  switch (period.kind) {
    case 'month':
      return formatMonthLabel(period.month, { locale });
    case 'custom':
      return t('tx.rangeLabel', {
        from: formatApiDate(period.from, { locale }),
        to: formatApiDate(period.to, { locale }),
      });
  }
}

/** The one filter field of the request slice, omitted-not-undefined as ever. */
function filterField(filter: TxWindowFilter): Pick<TxListFilters, 'category_id' | 'account_id'> {
  switch (filter.kind) {
    case 'category':
      return { category_id: filter.categoryId };
    case 'account':
      return { account_id: filter.accountId };
  }
}
