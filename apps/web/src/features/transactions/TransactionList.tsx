import { formatApiDate, sentenceEnd } from '@budget/shared';
import type { components } from '@budget/api-client';

import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { QueryStateNotice } from '../../components/QueryStateNotice';
import type { NamedAccount } from '../accounts/accountOptions';
import type { QueryPhase } from '../../lib/queryPhase';
import { groupByDay } from './groupByDay';
import { TransactionRow } from './TransactionRow';
import { useLocale, useT } from '../../i18n/context';
import styles from './TransactionList.module.css';

type CategoryRead = components['schemas']['CategoryRead'];
type TransactionRead = components['schemas']['TransactionRead'];

interface TransactionListProps {
  transactions: TransactionRead[];
  total: number;
  // The list query's phase (W1): 'unreachable' is a paused query, which used to
  // arrive here as 'pending' and render an eternal skeleton.
  phase: QueryPhase;
  hasMore: boolean;
  isLoadingMore: boolean;
  /**
   * What window the list is showing, in words — a month label, or "1 Aug – 15 Aug"
   * for a custom period. Empty-state copy only; all-time mode has no window to
   * name and does not use it.
   */
  periodLabel: string;
  categoryIndex: Map<string, CategoryRead>;
  // Profile base currency (from the month summary); undefined while it loads.
  summaryCurrency: string | undefined;
  // Template id -> template, for the row's "Recurring" chip (W3).
  recurringIndex: Map<string, { name: string }>;
  // Account id -> its display entry, for a transfer row's "A → B" names (W1).
  // Empty while the accounts query is pending or errored: the row then shows both
  // AMOUNTS (which come from the row itself) without the names, rather than
  // blocking. deposits W1: the map is MERGED with deposit ledgers, which
  // GET /accounts hides — otherwise a top-up row could never name its other side.
  accountsById: Map<string, NamedAccount>;
  // The account the list is filtered by (W2), or undefined for all accounts. It
  // decides which leg of a transfer a row shows (A3) and what the empty state
  // says.
  viewAccountId?: string;
  // S1: whether a CATEGORY filter is on, and whether the list is in all-time mode.
  // Both are empty-state concerns only — the rows themselves render identically —
  // so the ids stay in the page and only the facts the copy needs come down here.
  categoryFiltered: boolean;
  allTime: boolean;
  // S3: a search and/or a country filter is on. ONE flag, because they share one
  // way out (the combined "clear search and filters" button) and the empty copy
  // does not name them individually.
  otherFiltered: boolean;
  // S3: day headers describe a list ordered BY day. Under an amount sort they
  // would be one-row groups in no date order, so the list renders flat instead —
  // and each row then carries its own date, which the header used to supply.
  grouped: boolean;
  onClearAccountFilter: () => void;
  onClearCategoryFilter: () => void;
  onClearOtherFilters: () => void;
  onLoadMore: () => void;
  onRetry: () => void;
  /**
   * Opens a row's edit form. OPTIONAL since category-popup-and-ui-polish: the
   * category modal shows this same list READ-ONLY (a form inside an open Modal
   * would be a second dialog in the first one's DOM subtree — see
   * TransactionRow). Undefined makes every row static markup instead of a button
   * whose click does nothing.
   */
  onEdit?: (transaction: TransactionRead) => void;
  onAddFirst: () => void;
}

export function TransactionList({
  transactions,
  total,
  phase,
  hasMore,
  isLoadingMore,
  periodLabel,
  categoryIndex,
  summaryCurrency,
  recurringIndex,
  accountsById,
  viewAccountId,
  categoryFiltered,
  allTime,
  otherFiltered,
  grouped,
  onClearAccountFilter,
  onClearCategoryFilter,
  onClearOtherFilters,
  onLoadMore,
  onRetry,
  onEdit,
  onAddFirst,
}: TransactionListProps) {
  const locale = useLocale();
  const t = useT();
  if (phase === 'loading') {
    return (
      <Card size="none" className={styles.skeletons} aria-hidden="true">
        <div className={styles.skeletonRow} />
        <div className={styles.skeletonRow} />
        <div className={styles.skeletonRow} />
        <div className={styles.skeletonRow} />
      </Card>
    );
  }

  if (phase === 'error' || phase === 'unreachable') {
    return <QueryStateNotice phase={phase} message={t('tx.loadFailed')} onRetry={onRetry} />;
  }

  if (transactions.length === 0) {
    // The empty states differ because their NEXT STEPS differ: an untouched month
    // asks for a first transaction, while an empty filtered slice is far more often
    // the wrong filter than a genuinely empty history — so it offers the way out of
    // each filter that is on instead of an "add" that would not show up here.
    const accountFiltered = viewAccountId !== undefined;
    const filtered = accountFiltered || categoryFiltered || otherFiltered;
    // P3: `periodLabel` already ends in a dot in ru ("июнь 2026 г."), so the
    // terminator comes from the shared helper, not from the JSX.
    const message = !filtered
      ? allTime
        ? t('tx.emptyAll')
        : sentenceEnd(t('tx.emptyMonth', { month: periodLabel }))
      : allTime
        ? t('tx.emptyFiltered')
        : // The shipped account-only wording is kept: it is more specific than the
          // generic one, and this is still the same situation it described.
          sentenceEnd(
            accountFiltered && !categoryFiltered && !otherFiltered
              ? t('tx.emptyAccountMonth', { month: periodLabel })
              : t('tx.emptyFilteredMonth', { month: periodLabel }),
          );

    return (
      <EmptyState
        title={message}
        // What to do next, said only where there IS a next step: a filtered slice
        // gets the ways out below instead of an invitation to add a row that
        // would not show up here.
        description={filtered ? undefined : t('tx.emptyMonthCta')}
        actions={
          <>
            <Button variant="primary" onClick={onAddFirst}>
              {t('tx.add')}
            </Button>
            {/* Secondary weight: leaving a filter is a way back, not the main
                action. */}
            {accountFiltered ? (
              <Button onClick={onClearAccountFilter}>{t('tx.showAllAccounts')}</Button>
            ) : null}
            {/* One way out per filter that is on — except that the combined button
                below already clears the category, so the two never both appear. */}
            {categoryFiltered && !otherFiltered ? (
              <Button onClick={onClearCategoryFilter}>{t('tx.showAllCategories')}</Button>
            ) : null}
            {otherFiltered ? (
              <Button onClick={onClearOtherFilters}>{t('tx.emptyClearFilters')}</Button>
            ) : null}
          </>
        }
      />
    );
  }

  // One row renderer for both layouts, so the flat list can never drift from the
  // grouped one.
  const renderRow = (transaction: TransactionRead) => (
    <li key={transaction.id}>
      <TransactionRow
        transaction={transaction}
        category={transaction.category_id ? categoryIndex.get(transaction.category_id) : undefined}
        summaryCurrency={summaryCurrency}
        recurringIndex={recurringIndex}
        accountsById={accountsById}
        viewAccountId={viewAccountId}
        // Without day headers the row is the only place the date can appear, and
        // an amount-sorted list of undated rows is unreadable.
        showDate={!grouped}
        onEdit={onEdit}
      />
    </li>
  );

  return (
    <div className={styles.list}>
      {grouped ? (
        groupByDay(transactions).map((group) => (
          // The <section> is kept as the day's own element; the Card inside it is
          // the surface. One card per DAY (never per row): the day is the unit a
          // reader asks about, so the card edge and the day boundary coincide.
          <section key={group.date}>
            <Card size="none">
              <h2 className={styles.dayLabel}>{formatApiDate(group.date, { locale })}</h2>
              <ul className={styles.rows}>{group.items.map(renderRow)}</ul>
            </Card>
          </section>
        ))
      ) : (
        <Card size="none">
          <ul className={styles.rows}>{transactions.map(renderRow)}</ul>
        </Card>
      )}

      <div className={styles.footer}>
        <span className={styles.count}>
          {t('tx.showing', { shown: transactions.length, total })}
        </span>
        {hasMore ? (
          <Button onClick={onLoadMore} disabled={isLoadingMore}>
            {t(isLoadingMore ? 'common.loading' : 'common.loadMore')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
