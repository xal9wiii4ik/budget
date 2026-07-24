import { formatMoney } from '@budget/shared';
import type { components } from '@budget/api-client';

import styles from './TransactionList.module.css';

type CategoryRead = components['schemas']['CategoryRead'];
type TransactionRead = components['schemas']['TransactionRead'];

interface TransactionRowProps {
  transaction: TransactionRead;
  category: CategoryRead | undefined;
  onEdit: (transaction: TransactionRead) => void;
}

/**
 * One transaction row. The stored amount_minor is a magnitude (>=1); the SIGN is
 * carried by kind (T4/T8) — expense renders as a negative (locale minus via
 * formatMoney, red), income as positive (green). No toFixed / float. The category
 * name/icon is joined from the archived-inclusive index; a null category renders
 * "Uncategorized".
 */
export function TransactionRow({ transaction, category, onEdit }: TransactionRowProps) {
  const isExpense = transaction.kind === 'expense';
  const signedMinor = isExpense ? -transaction.amount_minor : transaction.amount_minor;
  const name =
    transaction.category_id === null ? 'Uncategorized' : (category?.name ?? 'Unknown category');

  return (
    <button type="button" className={styles.row} onClick={() => onEdit(transaction)}>
      <span className={styles.icon} aria-hidden="true">
        {category?.icon ?? '•'}
      </span>
      <span className={styles.details}>
        <span className={styles.categoryName}>{name}</span>
        {transaction.note ? <span className={styles.note}>{transaction.note}</span> : null}
      </span>
      <span className={`${styles.amount} ${isExpense ? styles.expense : styles.income}`}>
        {formatMoney(signedMinor, transaction.currency)}
      </span>
    </button>
  );
}
