import { formatMoney } from '@budget/shared';

import { Card } from '../../components/Card';
import type { SearchTotal } from '../../data/txSearch';
import { useLocale, useT } from '../../i18n/context';
import styles from './SearchTotals.module.css';

interface SearchTotalsProps {
  /** The SERVER's total over the retrieved rows, in the profile base currency. */
  total: SearchTotal;
  /**
   * What the figures are about, in words. A prop rather than a fixed key because
   * the two surfaces name the same thing in their own sentence
   * (`tx.searchTotalLabel` on the list, `advisor.qaTotalLabel` under an answer) —
   * and because a total with no label is exactly the thing that gets read as the
   * month's.
   */
  label: string;
}

/**
 * Income / expense / net over the operations a semantic search found (rag Web A).
 *
 * EVERY figure here is a SERVER field (`converted_total_for_rows`, D-R4): the
 * client adds nothing, converts nothing and derives nothing — `net_minor` is the
 * server's own income − expense, not a subtraction done on screen. That is the
 * project invariant, and it is also why this component exists instead of a
 * `reduce` over the rows: the rows carry amounts in their OWN currencies, and
 * summing them would be wrong in a way nobody would notice.
 *
 * It REPLACES `SummaryHeader` while a search by meaning is on screen (ruling
 * Q-4). Two totals on one screen read as one claim, and the month aggregate has
 * nothing to say about a set of rows chosen by closeness to a phrase.
 *
 * Shared by /transactions and the /advisor Q&A on purpose: the answer's total is
 * over the RETRIEVED set in the base currency (ASK-3 CONFIRMED), i.e. the very
 * same `total` object, and a second component would be a second opinion about
 * how the user's money is spelled.
 */
export function SearchTotals({ total, label }: SearchTotalsProps) {
  const locale = useLocale();
  const t = useT();
  const { currency } = total;

  return (
    <Card>
      <p className={styles.label}>{label}</p>
      <div className={styles.totals}>
        <div className={styles.total}>
          <span className={styles.totalLabel}>{t('common.income')}</span>
          <span className={`${styles.totalValue} ${styles.income} tnum`}>
            {formatMoney(total.income_minor, currency, { locale })}
          </span>
        </div>
        <div className={styles.total}>
          <span className={styles.totalLabel}>{t('common.expense')}</span>
          <span className={`${styles.totalValue} ${styles.expense} tnum`}>
            {formatMoney(total.expense_minor, currency, { locale })}
          </span>
        </div>
        <div className={styles.total}>
          <span className={styles.totalLabel}>{t('common.net')}</span>
          {/* Neutral by MEANING, never coloured by its sign — the two figures
              above carry the colour. */}
          <span className={`${styles.totalValue} ${styles.net} tnum`}>
            {formatMoney(total.net_minor, currency, { locale })}
          </span>
        </div>
      </div>

      {total.unconverted_count > 0 ? (
        // The same disclosure the month summary has made since D9: rows with no
        // exchange rate are EXCLUDED from a server total, and that exclusion is
        // said out loud rather than silently absorbed. Not an error — the answer
        // is still usable, it is just incomplete.
        <p className={styles.unconverted} role="status">
          {t('unconverted.totals', { count: total.unconverted_count })}
        </p>
      ) : null}
    </Card>
  );
}
