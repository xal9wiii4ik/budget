import { formatApiDate, sentenceEnd } from '@budget/shared';
import type { components } from '@budget/api-client';

import { QueryStateNotice } from '../../components/QueryStateNotice';
import type { QueryPhase } from '../../lib/queryPhase';
import { groupByDay } from './groupByDay';
import { TransactionRow } from './TransactionRow';
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
  onLoadMore,
  onRetry,
  onEdit,
  onAddFirst,
}: TransactionListProps) {
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
        message="Couldn't load transactions."
        onRetry={onRetry}
      />
    );
  }

  if (transactions.length === 0) {
    return (
      <div className={styles.empty}>
        {/* P3: `monthLabel` already ends in a dot in ru ("июнь 2026 г."), so the
            terminator comes from the shared helper, not from the JSX. */}
        <p>{sentenceEnd(`No transactions in ${monthLabel}`)} Add your first one.</p>
        <button type="button" className={styles.emptyAdd} onClick={onAddFirst}>
          Add transaction
        </button>
      </div>
    );
  }

  const groups = groupByDay(transactions);

  return (
    <div className={styles.list}>
      {groups.map((group) => (
        <section key={group.date} className={styles.dayGroup}>
          <h2 className={styles.dayLabel}>{formatApiDate(group.date)}</h2>
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
                  onEdit={onEdit}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}

      <div className={styles.footer}>
        <span className={styles.count}>
          Showing {transactions.length} of {total}
        </span>
        {hasMore ? (
          <button
            type="button"
            className={styles.loadMore}
            onClick={onLoadMore}
            disabled={isLoadingMore}
          >
            {isLoadingMore ? 'Loading…' : 'Load more'}
          </button>
        ) : null}
      </div>
    </div>
  );
}
