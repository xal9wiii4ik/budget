import { useState } from 'react';
import type { components } from '@budget/api-client';

import { Modal } from '../../components/Modal';
import { sortForDisplay } from '../../data/categoryLookup';
import { useLocale, useT } from '../../i18n/context';
import { filterCategories } from '../categories/categorySearch';
import styles from './CategoryPickerModal.module.css';

type CategoryRead = components['schemas']['CategoryRead'];

interface CategoryPickerModalProps {
  /** The archived-inclusive list; archived rows are filtered out here. */
  categories: CategoryRead[];
  /** What the row currently holds, so the list can mark it. */
  currentId: string | null;
  /** The line being categorised, for the dialog title. */
  rowDescription: string;
  isPending: boolean;
  errorMessage: string | null;
  onPick: (categoryId: string | null) => void;
  onClose: () => void;
}

/**
 * ONE category picker for the whole preview, opened from the row that needs it.
 *
 * The alternative — a `<select>` on every row — would mount a thousand controls
 * with twenty options each on a year's statement, which is precisely the freeze
 * this screen exists to avoid. It is also the honest shape of the interaction:
 * a category is chosen for one line at a time, and the search makes twenty
 * categories reachable without scrolling a dropdown.
 *
 * Archived categories are not offered (the server refuses them with
 * CATEGORY_ARCHIVED), and "no category" is a real option: an uncategorised
 * expense is legitimate, and clearing is what takes back a suggestion.
 */
export function CategoryPickerModal({
  categories,
  currentId,
  rowDescription,
  isPending,
  errorMessage,
  onPick,
  onClose,
}: CategoryPickerModalProps) {
  const t = useT();
  const locale = useLocale();
  const [query, setQuery] = useState('');

  const live = categories.filter((category) => !category.archived);
  const visible = sortForDisplay(filterCategories(live, query, locale), locale);

  return (
    <Modal title={t('imports.categoryTitle')} onClose={onClose} closeDisabled={isPending}>
      <div className={styles.panel}>
        <p className={styles.lede}>{rowDescription}</p>

        <label className={styles.label} htmlFor="import-category-search">
          {t('imports.categorySearch')}
        </label>
        <input
          id="import-category-search"
          type="search"
          className={styles.search}
          value={query}
          disabled={isPending}
          onChange={(event) => setQuery(event.target.value)}
        />

        {errorMessage === null ? null : (
          <p className={styles.error} role="alert">
            {errorMessage}
          </p>
        )}

        <ul className={styles.options}>
          <li>
            <button
              type="button"
              className={
                currentId === null ? `${styles.option} ${styles.optionActive}` : styles.option
              }
              disabled={isPending}
              onClick={() => onPick(null)}
            >
              {t('imports.categoryNone')}
            </button>
          </li>
          {visible.map((category) => (
            <li key={category.id}>
              <button
                type="button"
                className={
                  category.id === currentId
                    ? `${styles.option} ${styles.optionActive}`
                    : styles.option
                }
                disabled={isPending}
                onClick={() => onPick(category.id)}
              >
                <span aria-hidden="true">{category.icon ?? '•'}</span> {category.name}
              </button>
            </li>
          ))}
        </ul>
        {visible.length === 0 ? (
          <p className={styles.empty}>{t('imports.categoryNoMatch')}</p>
        ) : null}
      </div>
    </Modal>
  );
}
