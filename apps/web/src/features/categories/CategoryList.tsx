import type { components } from '@budget/api-client';
import { useMemo } from 'react';

import type { LimitsRead } from '../../data/limits';
import { useT } from '../../i18n/context';
import type { SimpleKey } from '../../i18n/t';
import { CategoryRow, type LimitSlotState } from './CategoryRow';
import styles from './CategoryList.module.css';

type CategoryRead = components['schemas']['CategoryRead'];

interface CategoryListProps {
  categories: CategoryRead[];
  onEdit: (category: CategoryRead) => void;
  /** This month's budgets — `undefined` while the query has not produced data. */
  limits: LimitsRead | undefined;
  /**
   * The budgets read failed. The section-level notice above the groups carries
   * the message and the retry, so the rows drop the slot entirely instead of
   * repeating an error per category.
   */
  limitsUnavailable: boolean;
}

// Kind -> heading KEY: the group titles are copy, so they follow the language.
const GROUPS: readonly { kind: CategoryRead['kind']; titleKey: SimpleKey }[] = [
  { kind: 'expense', titleKey: 'common.expense' },
  { kind: 'income', titleKey: 'common.income' },
];

/**
 * Kind-grouped category list. Input is pre-sorted (sortForDisplay), so filtering by
 * kind preserves the locale-aware within-group order.
 *
 * The limits response is joined to the rows HERE, by id, once: `GET /limits`
 * returns only categories that have a budget, so "no entry" is the common case
 * and a per-row `find()` over the list would be quadratic on a long list.
 */
export function CategoryList({
  categories,
  onEdit,
  limits,
  limitsUnavailable,
}: CategoryListProps) {
  const t = useT();
  const limitIndex = useMemo(() => {
    const index = new Map<string, LimitsRead['items'][number]>();
    for (const item of limits?.items ?? []) index.set(item.category_id, item);
    return index;
  }, [limits]);

  const slotFor = (category: CategoryRead): LimitSlotState => {
    if (limitsUnavailable) return { kind: 'hidden' };
    if (!limits) return { kind: 'loading' };
    return {
      kind: 'ready',
      item: limitIndex.get(category.id),
      currency: limits.currency,
    };
  };

  return (
    <div className={styles.groups}>
      {GROUPS.map(({ kind, titleKey }) => {
        const rows = categories.filter((category) => category.kind === kind);
        // A heading over nothing is noise, and under the S2 search it would be a
        // claim that the group has matches: a group with no rows is not rendered.
        if (rows.length === 0) return null;
        return (
          <section key={kind} className={styles.group}>
            <h2 className={styles.groupTitle}>{t(titleKey)}</h2>
            <ul className={styles.list}>
              {rows.map((category) => (
                <li key={category.id}>
                  <CategoryRow
                    category={category}
                    onEdit={onEdit}
                    limit={slotFor(category)}
                  />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
