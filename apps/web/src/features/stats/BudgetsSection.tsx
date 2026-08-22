import { formatMonthLabel } from '@budget/shared';
import { useMemo } from 'react';
import { Link } from 'react-router';

import { QueryStateNotice } from '../../components/QueryStateNotice';
import { useCategories } from '../../data/categories';
import { buildCategoryIndex } from '../../data/categoryLookup';
import { useLimits } from '../../data/limits';
import { LimitBar } from '../limits/LimitBar';
import { limitProgress } from '../limits/limitProgress';
import { useLocale, useT } from '../../i18n/context';
import { queryPhase } from '../../lib/queryPhase';
import { budgetsVisibility } from './budgetsVisibility';
import { UnconvertedNotice } from './UnconvertedNotice';
import type { PeriodSelection } from './period';
import styles from './BudgetsSection.module.css';

interface BudgetsSectionProps {
  selection: PeriodSelection;
}

/**
 * Budgets on `/stats` — READ-ONLY (WR-6). Set / Edit / Remove live on
 * `/categories` only: one write surface for one resource, so there is exactly one
 * place where a budget's currency stamp can change.
 *
 * The month-only gate is `budgetsVisibility` (Disagreement 1): a limit is a
 * calendar-month budget, so quarter / year / custom get an explanation instead of
 * a bar that would be measuring a different window from the one on screen.
 */
export function BudgetsSection({ selection }: BudgetsSectionProps) {
  const t = useT();
  const visibility = budgetsVisibility(selection);

  return (
    <section className={styles.section} aria-labelledby="budgets-heading">
      <header className={styles.header}>
        <h2 id="budgets-heading" className={styles.heading}>
          {t('budgets.heading')}
        </h2>
        <Link className={styles.link} to="/categories">
          {t('budgets.manage')}
        </Link>
      </header>

      {visibility.visible ? (
        <MonthBudgets month={visibility.month} />
      ) : (
        <p className={styles.note}>{t('budgets.monthOnly')}</p>
      )}
    </section>
  );
}

/**
 * The month arm, split into its own component so `useLimits` is called
 * unconditionally: the gate decides WHETHER this renders, never whether a hook
 * runs.
 */
function MonthBudgets({ month }: { month: string }) {
  const locale = useLocale();
  const t = useT();
  const limitsQuery = useLimits(month);
  const categoriesQuery = useCategories();
  const phase = queryPhase(limitsQuery);

  // Archived-INCLUSIVE join (T3): a budget on a since-archived category still
  // resolves to its name instead of reading "Unknown category".
  const categoryIndex = useMemo(
    () => buildCategoryIndex(categoriesQuery.data ?? []),
    [categoriesQuery.data],
  );

  if (phase === 'error' || phase === 'unreachable') {
    return (
      <QueryStateNotice
        phase={phase}
        message={t('categories.budgetsLoadFailed')}
        compact
        onRetry={() => {
          void limitsQuery.refetch();
        }}
      />
    );
  }

  if (!limitsQuery.isSuccess) {
    // 'loading' — the failing phases returned above. Three bars' worth of height,
    // so the sections below do not jump when the data lands.
    return (
      <div className={styles.skeleton} aria-hidden="true">
        <div className={styles.skeletonRow} />
        <div className={styles.skeletonRow} />
        <div className={styles.skeletonRow} />
      </div>
    );
  }

  const limits = limitsQuery.data;

  if (limits.items.length === 0) {
    return (
      <p className={styles.empty}>
        {t('budgets.emptyPrefix', { month: formatMonthLabel(month, { locale }) })}{' '}
        <Link to="/categories">{t('budgets.emptyLink')}</Link>{' '}
        {t('budgets.emptySuffix')}
      </p>
    );
  }

  return (
    <>
      {/* Period-level by design (D16) — one notice for the section, never one
          per bar, which would imply per-category counts the API does not return. */}
      <UnconvertedNotice count={limits.unconverted_count} scope="spentAmounts" />
      <ul className={styles.list}>
        {limits.items.map((item) => {
          const category = categoryIndex.get(item.category_id);
          const name = category?.name ?? t('common.unknownCategory');
          return (
            <li key={item.category_id} className={styles.row}>
              <span
                className={
                  category?.archived ? `${styles.name} ${styles.archived}` : styles.name
                }
              >
                {category?.icon ? <span aria-hidden="true">{category.icon} </span> : null}
                {name}
              </span>
              <LimitBar progress={limitProgress(item, limits.currency)} label={name} />
            </li>
          );
        })}
      </ul>
    </>
  );
}
