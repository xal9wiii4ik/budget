import { formatApiDate, sentenceEnd } from '@budget/shared';
import type { components } from '@budget/api-client';

import { QueryStateNotice } from '../../components/QueryStateNotice';
import type { AccountRead } from '../../data/accounts';
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
  monthLabel: string;
  categoryIndex: Map<string, CategoryRead>;
  // Profile base currency (from the month summary); undefined while it loads.
  summaryCurrency: string | undefined;
  // Template id -> template, for the row's "Recurring" chip (W3).
  recurringIndex: Map<string, { name: string }>;
  // Account id -> account, for a transfer row's "A → B" names (W1). Empty while
  // the accounts query is pending or errored: the row then shows both AMOUNTS
  // (which come from the row itself) without the names, rather than blocking.
  accountsById: Map<string, AccountRead>;
  // The account the list is filtered by (W2), or undefined for all accounts. It
  // decides which leg of a transfer a row shows (A3) and what the empty state
  // says.
  viewAccountId?: string;
  onClearAccountFilter: () => void;
  onLoadMore: () => void;
  onRetry: () => void;
  onEdit: (transaction: TransactionRead) => void;
  onAddFirst: () => void;
}

export function TransactionList({
  transactions,
  total,
  phase,
  hasMore,
  isLoadingMore,
  monthLabel,
  categoryIndex,
  summaryCurrency,
  recurringIndex,
  accountsById,
  viewAccountId,
  onClearAccountFilter,
  onLoadMore,
  onRetry,
  onEdit,
  onAddFirst,
}: TransactionListProps) {
  const locale = useLocale();
  const t = useT();
  if (phase === 'loading') {
    return (
      <div className={styles.rows} aria-hidden="true">
        <div className={styles.skeletonRow} />
        <div className={styles.skeletonRow} />
        <div className={styles.skeletonRow} />
        <div className={styles.skeletonRow} />
      </div>
    );
  }

  if (phase === 'error' || phase === 'unreachable') {
    return (
      <QueryStateNotice
        phase={phase}
        message={t('tx.loadFailed')}
        onRetry={onRetry}
      />
    );
  }

  if (transactions.length === 0) {
    // Two different empty states, because they have two different next steps: an
    // empty month asks for a first transaction, an empty ACCOUNT slice is far more
    // often the wrong account than an empty month — so it offers the way back to
    // all of them as well.
    return (
      <div className={styles.empty}>
        {/* P3: `monthLabel` already ends in a dot in ru ("июнь 2026 г."), so the
            terminator comes from the shared helper, not from the JSX. */}
        {viewAccountId === undefined ? (
          <p>
            {sentenceEnd(t('tx.emptyMonth', { month: monthLabel }))}{' '}
            {t('tx.emptyMonthCta')}
          </p>
        ) : (
          <p>{sentenceEnd(t('tx.emptyAccountMonth', { month: monthLabel }))}</p>
        )}
        <div className={styles.emptyActions}>
          <button type="button" className={styles.emptyAdd} onClick={onAddFirst}>
            {t('tx.add')}
          </button>
          {viewAccountId === undefined ? null : (
            <button
              type="button"
              className={styles.emptyClear}
              onClick={onClearAccountFilter}
            >
              {t('tx.showAllAccounts')}
            </button>
          )}
        </div>
      </div>
    );
  }

  const groups = groupByDay(transactions);

  return (
    <div className={styles.list}>
      {groups.map((group) => (
        <section key={group.date} className={styles.dayGroup}>
          <h2 className={styles.dayLabel}>{formatApiDate(group.date, { locale })}</h2>
          <ul className={styles.rows}>
            {group.items.map((transaction) => (
              <li key={transaction.id}>
                <TransactionRow
                  transaction={transaction}
                  category={
                    transaction.category_id
                      ? categoryIndex.get(transaction.category_id)
                      : undefined
                  }
                  summaryCurrency={summaryCurrency}
                  recurringIndex={recurringIndex}
                  accountsById={accountsById}
                  viewAccountId={viewAccountId}
                  onEdit={onEdit}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}

      <div className={styles.footer}>
        <span className={styles.count}>
          {t('tx.showing', { shown: transactions.length, total })}
        </span>
        {hasMore ? (
          <button
            type="button"
            className={styles.loadMore}
            onClick={onLoadMore}
            disabled={isLoadingMore}
          >
            {t(isLoadingMore ? 'common.loading' : 'common.loadMore')}
          </button>
        ) : null}
      </div>
    </div>
  );
}
