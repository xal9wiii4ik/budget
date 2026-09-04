import { formatMoney } from '@budget/shared';
import type { components } from '@budget/api-client';

import { Card } from '../../components/Card';
import type { useSummary } from '../../data/transactions';
import { useLocale, useT } from '../../i18n/context';
import styles from './SummaryHeader.module.css';

type CategoryRead = components['schemas']['CategoryRead'];
type CategorySummary = components['schemas']['CategorySummary'];

interface SummaryHeaderProps {
  summaryQuery: ReturnType<typeof useSummary>;
  categoryIndex: Map<string, CategoryRead>;
}

// React key + de-dup key: the refund case repeats a category_id under BOTH kinds,
// so category_id alone collides (T3). Compose with kind.
function breakdownKey(row: CategorySummary): string {
  return `${row.category_id ?? 'uncategorized'}:${row.kind}`;
}

/**
 * Month summary: income / expense / net totals + a per-category breakdown. All
 * amounts render via formatMoney (T4) — net is signed and formatMoney renders the
 * locale-correct minus; summary values are NEVER routed through toInputString. The
 * breakdown joins against the archived-INCLUSIVE category index so a since-archived
 * category (1.4 decision e) still resolves to its name instead of "unknown" (T3).
 */
export function SummaryHeader({ summaryQuery, categoryIndex }: SummaryHeaderProps) {
  const locale = useLocale();
  const t = useT();
  if (summaryQuery.isPending) {
    return (
      <Card aria-hidden="true">
        <div className={styles.totals}>
          {(['common.income', 'common.expense', 'common.net'] as const).map((key) => (
            <div key={key} className={styles.total}>
              <span className={styles.totalLabel}>{t(key)}</span>
              <span className={styles.skeletonFigure} />
            </div>
          ))}
        </div>
      </Card>
    );
  }

  if (summaryQuery.isError) {
    return (
      <Card>
        <p className={styles.error} role="alert">
          {t('summary.loadFailed')}
        </p>
      </Card>
    );
  }

  const summary = summaryQuery.data;
  const { currency } = summary;

  return (
    <Card>
      <div className={styles.totals}>
        <div className={styles.total}>
          <span className={styles.totalLabel}>{t('common.income')}</span>
          <span className={`${styles.totalValue} ${styles.income} tnum`}>
            {formatMoney(summary.income_minor, currency, { locale })}
          </span>
        </div>
        <div className={styles.total}>
          <span className={styles.totalLabel}>{t('common.expense')}</span>
          <span className={`${styles.totalValue} ${styles.expense} tnum`}>
            {formatMoney(summary.expense_minor, currency, { locale })}
          </span>
        </div>
        <div className={styles.total}>
          <span className={styles.totalLabel}>{t('common.net')}</span>
          <span className={`${styles.totalValue} ${styles.net} tnum`}>
            {formatMoney(summary.net_minor, currency, { locale })}
          </span>
        </div>
      </div>

      {summary.unconverted_count > 0 ? (
        // D9: rows with no exchange rate are EXCLUDED from the totals, and that
        // exclusion is disclosed rather than silently absorbed. Not an error —
        // the month is still usable, it is just incomplete.
        <p className={styles.unconverted} role="status">
          {t('unconverted.totals', { count: summary.unconverted_count })}
        </p>
      ) : null}

      {summary.by_category.length === 0 ? (
        <p className={styles.emptyBreakdown}>{t('summary.noSpend')}</p>
      ) : (
        <div className={styles.breakdown}>
          {summary.by_category.map((row) => {
            const category = row.category_id ? categoryIndex.get(row.category_id) : undefined;
            const name =
              row.category_id === null
                ? t('common.uncategorized')
                : (category?.name ?? t('common.unknownCategory'));
            const nameClass = category?.archived
              ? `${styles.breakdownName} ${styles.archivedName}`
              : styles.breakdownName;
            return (
              <div key={breakdownKey(row)} className={styles.breakdownRow}>
                <span className={nameClass}>
                  {category?.icon ? <span aria-hidden="true">{category.icon}</span> : null}
                  {name}
                </span>
                <span className={`${styles.breakdownAmount} tnum`}>
                  {formatMoney(row.total_minor, currency, { locale })}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
