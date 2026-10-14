import { formatApiDate, formatMoney } from '@budget/shared';
import { Link } from 'react-router';

import type {
  DiscrepancyRowView,
  DiscrepancyTxView,
  StatementDiscrepancy,
} from '../../data/imports';
import { useLocale, useT } from '../../i18n/context';
import styles from './ImportReconciliation.module.css';

interface ReconciliationItemProps {
  item: StatementDiscrepancy;
  /** The account+period transactions view — where the app side can be found. */
  transactionsHref: string;
}

/**
 * One finding of the agent: what the bank's line says, what the app's operation
 * says, and the model's own sentence about the pair.
 *
 * Both sides are EMBEDDED in the report (grooming ruling 1) and are rendered
 * from those mini views alone — no cache lookup, no second request. Which of
 * them is present is the contract's business, not this component's: a kind that
 * only ever has a row simply has `transaction: null`, and nothing is invented
 * for the missing side.
 *
 * `explanation` is MODEL TEXT: verbatim, React-escaped, never translated and
 * never run through `bankPhrases` (the advisor-answer rule). The server asked
 * the model to write it in the user's own language.
 *
 * No money arithmetic: each side prints its own server integer at its own
 * currency. The two may legitimately differ (that is what `fx_difference` IS),
 * so nothing here compares or converts them.
 */
export function ReconciliationItem({ item, transactionsHref }: ReconciliationItemProps) {
  const t = useT();

  const explanation = item.explanation.trim();

  return (
    <li className={styles.item}>
      <div className={styles.sides}>
        {item.row === null ? null : <RowSide row={item.row} />}
        {item.transaction === null ? (
          // The stored report keeps ids, so a transaction deleted since the run
          // comes back absent. Said out loud rather than left as a blank half:
          // "the app's side is gone" is the answer to the item, not a hole in
          // the screen. Only when the report really named one.
          item.transaction_id === null ? null : (
            <p className={styles.gone}>{t('imports.reconcileTxGone')}</p>
          )
        ) : (
          <TxSide transaction={item.transaction} transactionsHref={transactionsHref} />
        )}
      </div>
      {explanation === '' ? null : <p className={styles.explanation}>{explanation}</p>}
    </li>
  );
}

/** The bank's line, as the report embedded it. */
function RowSide({ row }: { row: DiscrepancyRowView }) {
  const t = useT();
  const locale = useLocale();
  const merchant = row.merchant?.trim() ?? '';
  // The merchant is the name the import would have written; the description is
  // the bank's own sentence and the fallback when there is no merchant. Neither
  // is translated — both are data.
  const name = merchant === '' ? row.description : merchant;

  return (
    <div className={styles.side}>
      <span className={styles.sideLabel}>{t('imports.reconcileRowLabel')}</span>
      <span className={styles.sideDate}>{formatApiDate(row.txn_date, { locale })}</span>
      <span className={styles.sideName}>
        {name.trim() === '' ? t('imports.candidateNoName') : name}
      </span>
      <span className={amountClass(row.kind)}>
        {formatMoney(signed(row.amount_minor, row.kind), row.currency, { locale })}
      </span>
    </div>
  );
}

/** The app's operation, plus the way to go and look at it. */
function TxSide({
  transaction,
  transactionsHref,
}: {
  transaction: DiscrepancyTxView;
  transactionsHref: string;
}) {
  const t = useT();
  const locale = useLocale();
  const merchant = transaction.merchant?.trim() ?? '';
  const note = transaction.note?.trim() ?? '';
  const name = merchant !== '' ? merchant : note;

  return (
    <div className={styles.side}>
      <span className={styles.sideLabel}>{t('imports.reconcileTxLabel')}</span>
      <span className={styles.sideDate}>
        {formatApiDate(transaction.occurred_at, { locale })}
      </span>
      <span className={styles.sideName}>
        {name === '' ? t('imports.candidateNoName') : name}
      </span>
      <span className={amountClass(transaction.kind)}>
        {formatMoney(signed(transaction.amount_minor, transaction.kind), transaction.currency, {
          locale,
        })}
      </span>
      {/* There is no single-transaction route in this app, so the link is the
          account+period list the import screen already points at — the embedded
          date, name and amount above are what let the user find the row there. */}
      <Link className={styles.sideLink} to={transactionsHref}>
        {t('imports.reconcileOpenTx')}
      </Link>
    </div>
  );
}

/**
 * The sign is the KIND's, exactly as on the preview rows: the server stores
 * every amount as a positive integer and the direction is the kind. A transfer
 * is neither spent nor received, so it keeps the bare figure.
 */
function signed(minor: number, kind: DiscrepancyRowView['kind']): number {
  return kind === 'expense' ? -minor : minor;
}

/** Coloured by MEANING, never by the sign of the number (the house rule). */
function amountClass(kind: DiscrepancyRowView['kind']): string {
  const tone =
    kind === 'expense'
      ? styles.expense
      : kind === 'income'
        ? styles.income
        : styles.transfer;
  return `${styles.sideAmount} ${tone} tnum`;
}
