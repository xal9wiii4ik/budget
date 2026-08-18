import type { components } from '@budget/api-client';
import { currentMonth, formatMonthLabel } from '@budget/shared';
import { useMemo, useState } from 'react';

import { QueryStateNotice } from '../components/QueryStateNotice';
import { useCategories } from '../data/categories';
import { sortForDisplay } from '../data/categoryLookup';
import { useLimits } from '../data/limits';
import { CategoryFormModal } from '../features/categories/CategoryFormModal';
import { CategoryList } from '../features/categories/CategoryList';
import { UnconvertedNotice } from '../features/stats/UnconvertedNotice';
import { queryPhase } from '../lib/queryPhase';
import styles from './CategoriesPage.module.css';

type CategoryRead = components['schemas']['CategoryRead'];

type ModalState =
  | { type: 'closed' }
  | { type: 'create' }
  | { type: 'edit'; category: CategoryRead };

export function CategoriesPage() {
  const categoriesQuery = useCategories();
  const phase = queryPhase(categoriesQuery);
  const [modal, setModal] = useState<ModalState>({ type: 'closed' });

  // /categories is NOT a period screen (OQ-W3): no month stepper, no URL param —
  // it shows THIS month's budgets, and `/stats` is where another month is picked.
  // The month is still sent explicitly so the cache key and the response always
  // describe the same window (a day rollover produces a new key, not a stale hit).
  const month = currentMonth();
  const limitsQuery = useLimits(month);
  const limitsPhase = queryPhase(limitsQuery);
  const limitsFailed = limitsPhase === 'error' || limitsPhase === 'unreachable';

  const sorted = useMemo(
    () => (categoriesQuery.data ? sortForDisplay(categoriesQuery.data) : []),
    [categoriesQuery.data],
  );

  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Categories</h1>
        <button
          type="button"
          className={styles.addButton}
          onClick={() => setModal({ type: 'create' })}
        >
          Add category
        </button>
      </header>

      {phase === 'loading' ? (
        <div className={styles.skeletonGroups} aria-hidden="true">
          <div className={styles.skeletonRow} />
          <div className={styles.skeletonRow} />
          <div className={styles.skeletonRow} />
        </div>
      ) : phase === 'error' || phase === 'unreachable' ? (
        <QueryStateNotice
          phase={phase}
          message="Couldn't load your categories."
          onRetry={() => {
            void categoriesQuery.refetch();
          }}
        />
      ) : (
        <>
          {/* ONE budgets notice for the whole screen, never per row: the read is
              a single query, and `unconverted_count` is period-level by design
              (D16) — a per-row marker would imply per-category counts the API
              deliberately does not return. */}
          <div className={styles.budgets}>
            <h2 className={styles.budgetsTitle}>Budgets for {formatMonthLabel(month)}</h2>
            {limitsPhase === 'error' || limitsPhase === 'unreachable' ? (
              <QueryStateNotice
                phase={limitsPhase}
                message="Couldn't load your budgets."
                compact
                onRetry={() => {
                  void limitsQuery.refetch();
                }}
              />
            ) : limitsQuery.data ? (
              <>
                <UnconvertedNotice
                  count={limitsQuery.data.unconverted_count}
                  scope="these spent amounts"
                />
                {limitsQuery.data.items.length === 0 ? (
                  <p className={styles.budgetsEmpty}>
                    No budgets yet — set one on any expense category to track how much
                    of it you&apos;ve used this month.
                  </p>
                ) : null}
              </>
            ) : null}
          </div>

          <CategoryList
            categories={sorted}
            onEdit={(category) => setModal({ type: 'edit', category })}
            limits={limitsQuery.data}
            limitsUnavailable={limitsFailed}
          />
        </>
      )}

      {modal.type === 'create' ? (
        <CategoryFormModal onClose={() => setModal({ type: 'closed' })} />
      ) : null}
      {modal.type === 'edit' ? (
        <CategoryFormModal
          key={modal.category.id}
          category={modal.category}
          onClose={() => setModal({ type: 'closed' })}
        />
      ) : null}
    </section>
  );
}
