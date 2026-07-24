import type { components } from '@budget/api-client';

import styles from './CategoryList.module.css';

type CategoryRead = components['schemas']['CategoryRead'];

interface CategoryRowProps {
  category: CategoryRead;
  onEdit: (category: CategoryRead) => void;
}

/**
 * A single category row. System categories (C4) are edit-gated: they render as a
 * non-interactive row with a "System" tag and no click affordance. User categories
 * render as a button that opens the edit modal.
 */
export function CategoryRow({ category, onEdit }: CategoryRowProps) {
  const inner = (
    <>
      <span
        className={styles.swatch}
        style={{ background: category.color ?? '#d1d5db' }}
        aria-hidden="true"
      />
      <span className={styles.icon} aria-hidden="true">
        {category.icon ?? '•'}
      </span>
      <span className={styles.name}>{category.name}</span>
      {category.archived ? <span className={styles.tag}>Archived</span> : null}
      {category.is_system ? <span className={styles.tag}>System</span> : null}
    </>
  );

  const className = category.archived ? `${styles.row} ${styles.archived}` : styles.row;

  if (category.is_system) {
    return <div className={className}>{inner}</div>;
  }

  return (
    <button type="button" className={className} onClick={() => onEdit(category)}>
      {inner}
    </button>
  );
}
