import type { components } from '@budget/api-client';
import { useMemo, useState } from 'react';

import { QueryStateNotice } from '../components/QueryStateNotice';
import { useCategories } from '../data/categories';
import { sortForDisplay } from '../data/categoryLookup';
import { CategoryFormModal } from '../features/categories/CategoryFormModal';
import { CategoryList } from '../features/categories/CategoryList';
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
        <CategoryList
          categories={sorted}
          onEdit={(category) => setModal({ type: 'edit', category })}
        />
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
