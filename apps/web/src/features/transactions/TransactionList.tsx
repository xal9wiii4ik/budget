import { formatApiDate } from '@budget/shared';
import type { components } from '@budget/api-client';

import { groupByDay } from './groupByDay';
import { TransactionRow } from './TransactionRow';
import styles from './TransactionList.module.css';

type CategoryRead = components['schemas']['CategoryRead'];
type TransactionRead = components['schemas']['TransactionRead'];

interface TransactionListProps {
  transactions: TransactionRead[];
  total: number;
  status: 'pending' | 'error' | 'success';
  hasMore: boolean;
  isLoadingMore: boolean;
  monthLabel: string;
  categoryIndex: Map<string, CategoryRead>;
  onLoadMore: () => void;
  onRetry: () => void;
  onEdit: (transaction: TransactionRead) => void;
  onAddFirst: () => void;
}

export function TransactionList({
  transactions,
  total,
  status,
  hasMore,
  isLoadingMore,
  monthLabel,
  categoryIndex,
  onLoadMore,
  onRetry,
  onEdit,
  onAddFirst,
}: TransactionListProps) {
  if (status === 'pending') {
    return (
      <div className={styles.rows} aria-hidden="true">
        <div className={styles.skeletonRow} />
        <div className={styles.skeletonRow} />
        <div className={styles.skeletonRow} />
        <div className={styles.skeletonRow} />
      </div>
    );
  }

  if (status === 'error') {
    return (
      <p className={styles.error} role="alert">
        Couldn&apos;t load transactions.
        <button type="button" className={styles.retry} onClick={onRetry}>
          Retry
        </button>
      </p>
    );
  }

  if (transactions.length === 0) {
    return (
      <div className={styles.empty}>
        <p>No transactions in {monthLabel}. Add your first one.</p>
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
