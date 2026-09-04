import type { components } from '@budget/api-client';
import { currentMonth, formatMonthLabel } from '@budget/shared';
import { useMemo, useState } from 'react';

import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { Input } from '../components/Field';
import { PageHeader } from '../components/PageHeader';
import { QueryStateNotice } from '../components/QueryStateNotice';
import { useCategories } from '../data/categories';
import { sortForDisplay } from '../data/categoryLookup';
import { useLimits } from '../data/limits';
import { useLocale, useT } from '../i18n/context';
import { CategoryFormModal } from '../features/categories/CategoryFormModal';
import { CategoryList } from '../features/categories/CategoryList';
import { filterCategories } from '../features/categories/categorySearch';
import { UnconvertedNotice } from '../features/stats/UnconvertedNotice';
import { queryPhase } from '../lib/queryPhase';
import styles from './CategoriesPage.module.css';

type CategoryRead = components['schemas']['CategoryRead'];

type ModalState =
  | { type: 'closed' }
  | { type: 'create' }
  | { type: 'edit'; category: CategoryRead };

export function CategoriesPage() {
  const t = useT();
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

  // The names are already translated (data/categories select), so the collator
  // must run in the chosen language too — otherwise "Ёлка" sorts by the host's
  // rules, not the user's.
  const locale = useLocale();
  const sorted = useMemo(
    () => (categoriesQuery.data ? sortForDisplay(categoriesQuery.data, locale) : []),
    [categoriesQuery.data, locale],
  );

  // S2: the search is EPHEMERAL local state, deliberately not a URL parameter —
  // "what I am typing right now" is nothing to share or to restore on back, unlike
  // the transaction filters. The whole list is already in the cache, so the filter
  // is a client-side derive during render: no request, no effect, no second copy.
  const [search, setSearch] = useState('');
  const visible = useMemo(
    () => filterCategories(sorted, search, locale),
    [sorted, search, locale],
  );
  const searching = search.trim() !== '';

  return (
    <section className={styles.page}>
      <PageHeader
        title={t('categories.title')}
        actions={
          <Button variant="primary" onClick={() => setModal({ type: 'create' })}>
            {t('categories.add')}
          </Button>
        }
      />

      {phase === 'loading' ? (
        <div className={styles.skeletonGroups} aria-hidden="true">
          <div className={styles.skeletonRow} />
          <div className={styles.skeletonRow} />
          <div className={styles.skeletonRow} />
        </div>
      ) : phase === 'error' || phase === 'unreachable' ? (
        <QueryStateNotice
          phase={phase}
          message={t('categories.loadFailed')}
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
            <h2 className={styles.budgetsTitle}>
              {t('categories.budgetsTitle', { month: formatMonthLabel(month, { locale }) })}
            </h2>
            {limitsPhase === 'error' || limitsPhase === 'unreachable' ? (
              <QueryStateNotice
                phase={limitsPhase}
                message={t('categories.budgetsLoadFailed')}
                compact
                onRetry={() => {
                  void limitsQuery.refetch();
                }}
              />
            ) : limitsQuery.data ? (
              <>
                <UnconvertedNotice
                  count={limitsQuery.data.unconverted_count}
                  scope="spentAmounts"
                />
                {limitsQuery.data.items.length === 0 ? (
                  <p className={styles.budgetsEmpty}>{t('categories.budgetsEmpty')}</p>
                ) : null}
              </>
            ) : null}
          </div>

          <div className={styles.search}>
            <Input
              type="search"
              value={search}
              aria-label={t('categories.searchLabel')}
              placeholder={t('categories.searchPlaceholder')}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>

          {searching && visible.length === 0 ? (
            // Gated on the QUERY, not just on emptiness: "nothing matches ''" is
            // not a sentence, and an empty screen with no search is the category
            // list's own (theoretical) empty state, not the search's.
            <EmptyState
              title={t('categories.searchEmpty', { query: search.trim() })}
              actions={
                <Button onClick={() => setSearch('')}>
                  {t('categories.searchClearAction')}
                </Button>
              }
            />
          ) : (
            <CategoryList
              categories={visible}
              onEdit={(category) => setModal({ type: 'edit', category })}
              limits={limitsQuery.data}
              limitsUnavailable={limitsFailed}
            />
          )}
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
