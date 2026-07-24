import { formatMoney } from '@budget/shared';
import type { components } from '@budget/api-client';

import type { useSummary } from '../../data/transactions';
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
  if (summaryQuery.isPending) {
    return (
      <div className={styles.card} aria-hidden="true">
        <div className={styles.totals}>
          {['Income', 'Expense', 'Net'].map((label) => (
            <div key={label} className={styles.total}>
              <span className={styles.totalLabel}>{label}</span>
              <span className={styles.skeletonFigure} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (summaryQuery.isError) {
    return (
      <div className={styles.card}>
        <p className={styles.error} role="alert">
          Couldn&apos;t load this month&apos;s summary.
        </p>
      </div>
    );
  }

  const summary = summaryQuery.data;
  const { currency } = summary;

  return (
    <div className={styles.card}>
      <div className={styles.totals}>
        <div className={styles.total}>
          <span className={styles.totalLabel}>Income</span>
          <span className={`${styles.totalValue} ${styles.income}`}>
            {formatMoney(summary.income_minor, currency)}
          </span>
        </div>
        <div className={styles.total}>
          <span className={styles.totalLabel}>Expense</span>
          <span className={`${styles.totalValue} ${styles.expense}`}>
            {formatMoney(summary.expense_minor, currency)}
          </span>
        </div>
        <div className={styles.total}>
          <span className={styles.totalLabel}>Net</span>
          <span className={`${styles.totalValue} ${styles.net}`}>
            {formatMoney(summary.net_minor, currency)}
          </span>
        </div>
      </div>

      {summary.by_category.length === 0 ? (
        <p className={styles.emptyBreakdown}>No spend yet this month.</p>
      ) : (
        <div className={styles.breakdown}>
          {summary.by_category.map((row) => {
            const category = row.category_id ? categoryIndex.get(row.category_id) : undefined;
            const name = row.category_id === null ? 'Uncategorized' : (category?.name ?? 'Unknown category');
            const nameClass = category?.archived
              ? `${styles.breakdownName} ${styles.archivedName}`
              : styles.breakdownName;
            return (
              <div key={breakdownKey(row)} className={styles.breakdownRow}>
                <span className={nameClass}>
                  {category?.icon ? <span aria-hidden="true">{category.icon}</span> : null}
                  {name}
                </span>
                <span>{formatMoney(row.total_minor, currency)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
