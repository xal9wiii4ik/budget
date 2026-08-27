import { currentMonth, formatApiDate, formatMoney, formatMonthLabel } from '@budget/shared';
import type { components } from '@budget/api-client';
import { useState } from 'react';
import { Link } from 'react-router';

import { Modal } from '../../components/Modal';
import { QueryStateNotice } from '../../components/QueryStateNotice';
import type { NamedAccount } from '../accounts/accountOptions';
import type { TxListFilters } from '../../data/queryKeys';
import { useStatsSummary } from '../../data/stats';
import { useTransactions } from '../../data/transactions';
import { useLocale, useT } from '../../i18n/context';
import { queryPhase } from '../../lib/queryPhase';
import { UnconvertedNotice } from '../stats/UnconvertedNotice';
import { TransactionList } from '../transactions/TransactionList';
import { TxRangePicker } from '../transactions/TxRangePicker';
import { rangeBounds, TX_LIST_LIMIT, type TxRangeMode } from '../transactions/txFilters';
import {
  categoryPeriodTotal,
  categoryStatsPeriod,
  categoryTransactionsHref,
  type CategoryPeriod,
} from './categoryDrilldown';
import styles from './CategoryTransactionsModal.module.css';

type CategoryRead = components['schemas']['CategoryRead'];

// Module-level so the identity is stable across renders (these are props of a
// memo-free component tree, but a fresh Map per render is still needless work).
//
// recurring: /categories does not hold the template list, and the modal will not
// fetch one for a chip — an unresolved id lands in the row's documented
// name-less arm ("Recurring" with no template name), never blocking a row.
const NO_TEMPLATES: Map<string, { name: string }> = new Map();
// accounts: a transfer has NO category (its category_id is null by design), so a
// category-filtered list cannot contain one and the transfer arm's name lookup
// is unreachable here.
const NO_ACCOUNTS: Map<string, NamedAccount> = new Map();

interface CategoryTransactionsModalProps {
  category: CategoryRead;
  onClose: () => void;
}

/**
 * One category's operations, over the screen that listed it (task.md 2).
 *
 * The user's question here is "how much did I spend on this, and on what" — the
 * whole /transactions screen (its own month summary, search, filter panel and
 * toolbar) answers nine other questions on the way and costs the context of the
 * category screen. So this window carries exactly three things: a period, the
 * SERVER's total for it, and the rows.
 *
 * The period is LOCAL state, deliberately not the URL: nothing here is a
 * destination to share or to restore with the back button — the way to a shareable
 * view is the "open all operations" link at the bottom, which reproduces this very
 * window on /transactions (`categoryTransactionsHref`).
 *
 * The total is `/stats/summary`'s own `total_minor` for this category, picked by
 * id and kind (`categoryPeriodTotal`) — the client sums nothing. That is also why
 * the picker's "all time" mode is hidden here (`allowAllTime={false}`): the stats
 * period grammar has no all-time unit, and a list with no total to head it would
 * be exactly the question this window exists to answer, unanswered.
 *
 * The rows come from the SAME query (same key, same page size) the /transactions
 * screen uses for this category, so opening the window twice — or opening it and
 * then the full screen — reuses one cache entry instead of refetching.
 */
export function CategoryTransactionsModal({
  category,
  onClose,
}: CategoryTransactionsModalProps) {
  const t = useT();
  const locale = useLocale();
  // The month the stepper shows, kept while a custom period is on so "back to
  // this month" returns to what was being read (the /transactions rule, minus
  // the URL). While `period` is a month, the two are the same value.
  const [monthAnchor, setMonthAnchor] = useState(() => currentMonth());
  const [period, setPeriod] = useState<CategoryPeriod>(() => ({
    kind: 'month',
    month: currentMonth(),
  }));

  const summaryQuery = useStatsSummary(categoryStatsPeriod(period));
  const summaryPhase = queryPhase(summaryQuery);

  // Byte-for-byte the filter slice /transactions builds for `?category=…` with
  // this window (`rangeBounds` + `TX_LIST_LIMIT` are that screen's own), so both
  // read one cache entry.
  const filters: TxListFilters = {
    ...rangeBounds(period),
    category_id: category.id,
    limit: TX_LIST_LIMIT,
  };
  const txQuery = useTransactions(filters);
  const txPhase = queryPhase(txQuery);
  const transactions = txQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const total = txQuery.data?.pages[0]?.total ?? 0;

  const periodLabel =
    period.kind === 'month'
      ? formatMonthLabel(period.month, { locale })
      : t('tx.rangeLabel', {
          from: formatApiDate(period.from, { locale }),
          to: formatApiDate(period.to, { locale }),
        });

  const onRangeChange = (next: TxRangeMode) => {
    // The picker's union has three modes; with `allowAllTime={false}` it never
    // emits this one, and the modal has no total to show for it (see above).
    if (next.kind === 'all') return;
    if (next.kind === 'month') setMonthAnchor(next.month);
    setPeriod(next);
  };

  // The list's empty branch is unreachable here — the window renders its own
  // empty state below — and these four callbacks live only inside it: "add a
  // transaction" and "clear this filter" are both meaningless in a window that
  // IS one category.
  const unreachable = () => {};

  return (
    // No `isDirty`: there is no form in here, so all three close channels (Esc,
    // backdrop, ×) close it straight away.
    <Modal title={category.name} onClose={onClose}>
      <div className={styles.window}>
        <TxRangePicker
          mode={period}
          month={monthAnchor}
          allowAllTime={false}
          onChange={onRangeChange}
        />

        {summaryPhase === 'loading' ? (
          <div className={styles.totalSkeleton} aria-hidden="true" />
        ) : summaryPhase === 'error' || summaryPhase === 'unreachable' ? (
          <QueryStateNotice
            phase={summaryPhase}
            message={t('categoryTx.totalFailed')}
            compact
            onRetry={() => {
              void summaryQuery.refetch();
            }}
          />
        ) : summaryQuery.data === undefined ? null : (
          <div className={styles.total}>
            <span className={styles.totalLabel}>{t('categoryTx.total')}</span>
            <strong className={styles.totalValue}>
              {formatMoney(
                categoryPeriodTotal(summaryQuery.data, category.id, category.kind),
                // The response's OWN currency (the profile base) — never a
                // currency from somewhere else on the screen.
                summaryQuery.data.currency,
                { locale },
              )}
            </strong>
            <UnconvertedNotice
              count={summaryQuery.data.unconverted_count}
              scope="totals"
            />
          </div>
        )}

        {txPhase === 'ready' && transactions.length === 0 ? (
          <p className={styles.empty}>{t('categoryTx.empty')}</p>
        ) : (
          // The rows scroll, the period control and the total above them and the
          // link below do not: the answer stays on screen while the evidence for
          // it is scrolled through.
          //
          // Focusable (`tabIndex={0}`) because its contents are NOT: the rows are
          // static in here, so without a stop of its own a keyboard-only user
          // could not scroll the region at all. The label is the same sentence
          // the drill-down button carries.
          <div
            className={styles.list}
            role="group"
            tabIndex={0}
            aria-label={t('categories.viewTransactionsFor', { name: category.name })}
          >
            <TransactionList
              transactions={transactions}
              total={total}
              phase={txPhase}
              hasMore={txQuery.hasNextPage}
              isLoadingMore={txQuery.isFetchingNextPage}
              periodLabel={periodLabel}
              // Every row in this list is in THIS category (the server filtered
              // them), so the one entry is the whole join.
              categoryIndex={new Map([[category.id, category]])}
              // = the profile base currency, from the response that already has
              // to be on screen for the total.
              summaryCurrency={summaryQuery.data?.currency}
              recurringIndex={NO_TEMPLATES}
              accountsById={NO_ACCOUNTS}
              categoryFiltered
              allTime={false}
              otherFiltered={false}
              grouped
              onClearAccountFilter={unreachable}
              onClearCategoryFilter={unreachable}
              onClearOtherFilters={unreachable}
              onLoadMore={() => {
                void txQuery.fetchNextPage();
              }}
              onRetry={() => {
                void txQuery.refetch();
              }}
              // No `onEdit`: the rows are read-only in here (TransactionRow).
              onAddFirst={unreachable}
            />
          </div>
        )}

        {/* The full screen is still one click away — with the same category and
            the same window, so nothing has to be set up again there. */}
        <Link className={styles.openAll} to={categoryTransactionsHref(category.id, period)}>
          {t('categoryTx.openAll')}
        </Link>
      </div>
    </Modal>
  );
}
