import { formatMoney } from '@budget/shared';
import type { components } from '@budget/api-client';

import type { CategorySummary, StatsSummaryRead } from '../../data/stats';
import { useLocale, useT } from '../../i18n/context';
import { share } from './comparison';
import styles from './CategoryBreakdown.module.css';

type CategoryRead = components['schemas']['CategoryRead'];

interface CategoryBreakdownProps {
  summary: StatsSummaryRead;
  categoryIndex: Map<string, CategoryRead>;
}

// React key + de-dup key: a refund repeats a category_id under BOTH kinds, so
// category_id alone collides (the shipped SummaryHeader precedent).
function rowKey(row: CategorySummary): string {
  return `${row.category_id ?? 'uncategorized'}:${row.kind}`;
}

/**
 * The per-category breakdown, rendered in the SERVER's order — `(kind, total
 * DESC)` — with no client re-sort, no re-grouping and no summing. Shares are a
 * percentage of the server's own `expense_minor` / `income_minor` for that kind
 * (never of a client-summed bucket total): if the buckets ever fail to add up to
 * the server's total, the shares visibly fail to reach 100 % rather than being
 * normalized into agreement.
 *
 * Names join against the archived-INCLUSIVE category index, so a since-archived
 * category still resolves instead of reading "Unknown category". Amounts decode
 * with `summary.currency` — this response's own field (AM-5).
 */
export function CategoryBreakdown({ summary, categoryIndex }: CategoryBreakdownProps) {
  const locale = useLocale();
  const t = useT();
  const { currency } = summary;

  if (summary.by_category.length === 0) return null;

  return (
    <div className={styles.breakdown}>
      <h3 className={styles.heading}>{t('breakdown.heading')}</h3>
      <ul className={styles.list}>
        {summary.by_category.map((row) => {
          const category = row.category_id ? categoryIndex.get(row.category_id) : undefined;
          const name =
            row.category_id === null
              ? t('common.uncategorized')
              : (category?.name ?? t('common.unknownCategory'));
          const kindTotal =
            row.kind === 'expense' ? summary.expense_minor : summary.income_minor;
          const percent = share(row.total_minor, kindTotal);
          return (
            <li key={rowKey(row)} className={styles.row}>
              <span
                className={
                  category?.archived ? `${styles.name} ${styles.archived}` : styles.name
                }
              >
                {category?.icon ? <span aria-hidden="true">{category.icon}</span> : null}
                {name}
                <span className={styles.kind}>
                  {t(row.kind === 'expense' ? 'common.expense' : 'common.income')}
                </span>
              </span>
              <span className={styles.amount}>
                {formatMoney(row.total_minor, currency, { locale })}
              </span>
              <span className={styles.share}>{percent === null ? '—' : `${percent}%`}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
