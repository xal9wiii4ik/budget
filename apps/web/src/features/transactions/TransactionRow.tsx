import { formatMoney } from '@budget/shared';
import type { components } from '@budget/api-client';

import type { AccountRead } from '../../data/accounts';
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
  // Account id -> account (W1). Only the transfer arm reads it, and only for
  // NAMES: both amounts and both currencies come from the row itself.
  accountsById: Map<string, AccountRead>;
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
  accountsById,
  onEdit,
}: TransactionRowProps) {
  // accounts-and-transfers W1: a transfer is ONE row showing BOTH sides (A1) —
  // it has no category and no base equivalent (its base pair is NULL by CHECK,
  // §5), so it takes its own branch instead of threading nulls through this one.
  if (transaction.kind === 'transfer') {
    return (
      <TransferRow transaction={transaction} accountsById={accountsById} onEdit={onEdit} />
    );
  }

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

/**
 * A transfer row: "Card USD → Card BYN" with the two amounts the user actually
 * moved — money OUT of the source in the source's currency, money IN to the
 * target in the target's currency (addendum A5 puts `counter_currency` on the
 * row, so no join is needed to render either).
 *
 * The sign is a DIRECTION marker, not arithmetic: the stored magnitudes are
 * rendered with a leading minus/plus by `formatMoney`, and nothing here adds,
 * subtracts or divides them. In particular the exchange rate is NOT computed
 * here — `transfer_rate` is a server field (A2) and the form shows it verbatim.
 *
 * Clicking opens the ONE form that edits both sides together (A1).
 *
 * W2 owns the richer version of this (a `transferDisplay` helper, the per-account
 * signed leg from `signedLegFor`, the account filter); this is the minimum that
 * makes a transfer readable and editable in W1.
 */
function TransferRow({
  transaction,
  accountsById,
  onEdit,
}: {
  transaction: TransactionRead;
  accountsById: Map<string, AccountRead>;
  onEdit: (transaction: TransactionRead) => void;
}) {
  const source = accountsById.get(transaction.account_id);
  const target =
    transaction.counter_account_id === null
      ? undefined
      : accountsById.get(transaction.counter_account_id);

  return (
    <button type="button" className={styles.row} onClick={() => onEdit(transaction)}>
      <span className={styles.icon} aria-hidden="true">
        ⇄
      </span>
      <span className={styles.details}>
        {/* Never "Uncategorized": a transfer HAS no category (that word belongs to
            spending without one), so the two accounts take that line. Names are
            omitted, not guessed, while the account list is still loading. */}
        <span className={styles.categoryName}>
          Transfer{source && target ? `: ${source.name} → ${target.name}` : ''}
        </span>
        {transaction.note ? <span className={styles.note}>{transaction.note}</span> : null}
      </span>
      <span className={styles.amountCell}>
        <span className={`${styles.amount} ${styles.expense}`}>
          {formatMoney(-transaction.amount_minor, transaction.currency)}
        </span>
        {transaction.counter_amount_minor !== null &&
        transaction.counter_currency !== null ? (
          <span className={`${styles.amount} ${styles.income}`}>
            {formatMoney(transaction.counter_amount_minor, transaction.counter_currency)}
          </span>
        ) : null}
      </span>
    </button>
  );
}
