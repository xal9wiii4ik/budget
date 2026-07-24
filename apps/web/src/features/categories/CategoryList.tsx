import type { components } from '@budget/api-client';

import { CategoryRow } from './CategoryRow';
import styles from './CategoryList.module.css';

type CategoryRead = components['schemas']['CategoryRead'];

interface CategoryListProps {
  categories: CategoryRead[];
  onEdit: (category: CategoryRead) => void;
}

const GROUPS: { kind: CategoryRead['kind']; title: string }[] = [
  { kind: 'expense', title: 'Expense' },
  { kind: 'income', title: 'Income' },
];

/**
 * Kind-grouped category list. Input is pre-sorted (sortForDisplay), so filtering by
 * kind preserves the locale-aware within-group order.
 */
export function CategoryList({ categories, onEdit }: CategoryListProps) {
  return (
    <div className={styles.groups}>
      {GROUPS.map(({ kind, title }) => {
        const rows = categories.filter((category) => category.kind === kind);
        return (
          <section key={kind} className={styles.group}>
            <h2 className={styles.groupTitle}>{title}</h2>
            <ul className={styles.list}>
              {rows.map((category) => (
                <li key={category.id}>
                  <CategoryRow category={category} onEdit={onEdit} />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
