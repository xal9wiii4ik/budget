import { formatMoney } from '@budget/shared';
import type { components } from '@budget/api-client';

import { recurringBadge } from './recurringBadge';
import { baseEquivalent } from './rowDisplay';
import styles from './TransactionList.module.css';

type CategoryRead = components['schemas']['CategoryRead'];
type TransactionRead = components['schemas']['TransactionRead'];

interface TransactionRowProps {
  transaction: TransactionRead;
  category: CategoryRead | undefined;
  // The month summary's currency = the profile base currency. `undefined` while
  // the summary is still loading/errored: rows then render their own amount only
  // — a base equivalent cannot be judged stale without knowing the base.
  summaryCurrency: string | undefined;
  // id -> template, from the cached ['recurring','list'] query (W3). Empty while
  // that query is pending or errored, which lands in the same name-less arm as a
  // cache miss — the badge never blocks or delays a row.
  recurringIndex: Map<string, { name: string }>;
  onEdit: (transaction: TransactionRead) => void;
}

/**
 * One transaction row. The stored amount_minor is a magnitude (>=1); the SIGN is
 * carried by kind (T4/T8) — expense renders as a negative (locale minus via
 * formatMoney, red), income as positive (green). No toFixed / float. The category
 * name/icon is joined from the archived-inclusive index; a null category renders
 * "Uncategorized".
 *
 * 3.2: the primary amount is ALWAYS the row's own currency (T8′). A foreign row
 * additionally shows its stored base-currency snapshot as a muted "≈" line,
 * decoded with that snapshot's own paired currency (see rowDisplay).
 *
 * 5.3: a row a template created carries a "Recurring" chip — the honesty
 * mechanism for silent materialization (D9). Read-only: the badge changes no
 * write path and no invalidation.
 */
export function TransactionRow({
  transaction,
  category,
  summaryCurrency,
  recurringIndex,
  onEdit,
}: TransactionRowProps) {
  const isExpense = transaction.kind === 'expense';
  const signedMinor = isExpense ? -transaction.amount_minor : transaction.amount_minor;
  const name =
    transaction.category_id === null ? 'Uncategorized' : (category?.name ?? 'Unknown category');
  const equivalent =
    summaryCurrency === undefined ? null : baseEquivalent(transaction, summaryCurrency);
  const recurring = recurringBadge(transaction, recurringIndex);

  return (
    <button type="button" className={styles.row} onClick={() => onEdit(transaction)}>
      <span className={styles.icon} aria-hidden="true">
        {category?.icon ?? '•'}
      </span>
      <span className={styles.details}>
        <span className={styles.categoryName}>{name}</span>
        {recurring ? (
          // A static <span>, not a control: the row itself is the <button> and
          // nothing focusable may nest inside it.
          <span className={styles.recurringChip}>
            Recurring{recurring.name === undefined ? '' : ` · ${recurring.name}`}
          </span>
        ) : null}
        {transaction.note ? <span className={styles.note}>{transaction.note}</span> : null}
      </span>
      <span className={styles.amountCell}>
        <span className={`${styles.amount} ${isExpense ? styles.expense : styles.income}`}>
          {formatMoney(signedMinor, transaction.currency)}
        </span>
        {equivalent ? (
          <span className={styles.baseEquivalent}>
            ≈ {formatMoney(isExpense ? -equivalent.minor : equivalent.minor, equivalent.currency)}
          </span>
        ) : null}
      </span>
    </button>
  );
}
