import type { components } from '@budget/api-client';
import { useState } from 'react';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useDeleteLimit, type LimitItem } from '../../data/limits';
import { LimitBar } from '../limits/LimitBar';
import { LimitFormModal } from '../limits/LimitFormModal';
import { limitProgress } from '../limits/limitProgress';
import { useLang, useT } from '../../i18n/context';
import { describeLimitError } from '../../lib/errors';
import styles from './CategoryList.module.css';

type CategoryRead = components['schemas']['CategoryRead'];

/**
 * What the row knows about this month's budgets (W4).
 *
 * `hidden` is the FAILED read: the section-level notice above the groups already
 * says the budgets could not be loaded and offers the retry, so a per-row error
 * would repeat that message once per category (WR-6 / the UI-states table).
 * `loading` reserves the slot's height so the list does not jump when the query
 * lands (see `LimitSlot` for where the reservation applies).
 */
export type LimitSlotState =
  | { kind: 'hidden' }
  | { kind: 'loading' }
  | { kind: 'ready'; item: LimitItem | undefined; currency: string };

interface CategoryRowProps {
  category: CategoryRead;
  onEdit: (category: CategoryRead) => void;
  limit: LimitSlotState;
}

/**
 * A single category row. System categories (C4) are edit-gated: they render as a
 * non-interactive row with a "System" tag and no click affordance. User categories
 * render as a button that opens the edit modal.
 *
 * Since W4 the row is a WRAPPER: the category itself stays the same button/div,
 * and the budget slot sits beside it as a sibling — never inside, because the slot
 * carries its own buttons and a button cannot nest in a button.
 */
export function CategoryRow({ category, onEdit, limit }: CategoryRowProps) {
  const t = useT();
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
      {category.archived ? (
        <span className={styles.tag}>{t('common.archivedTag')}</span>
      ) : null}
      {category.is_system ? (
        <span className={styles.tag}>{t('categories.systemTag')}</span>
      ) : null}
    </>
  );

  const className = category.archived ? `${styles.row} ${styles.archived}` : styles.row;

  return (
    <div className={styles.rowWrap}>
      {category.is_system ? (
        <div className={className}>{inner}</div>
      ) : (
        <button type="button" className={className} onClick={() => onEdit(category)}>
          {inner}
        </button>
      )}
      <LimitSlot category={category} state={limit} />
    </div>
  );
}

/**
 * Whether this row shows a budget slot at all, and in which shape.
 *
 * Budgets are an EXPENSE concept (the server answers `CATEGORY_NOT_EXPENSE`
 * otherwise), so income rows get no slot — not an empty one.
 */
function LimitSlot({
  category,
  state,
}: {
  category: CategoryRead;
  state: LimitSlotState;
}) {
  if (category.kind !== 'expense' || state.kind === 'hidden') return null;
  if (state.kind === 'loading') {
    // Height is reserved only where something is CERTAIN to land: a non-archived
    // expense row always ends up with either "Set a budget" or a bar. An archived
    // one may end up with nothing at all, so reserving there would guarantee the
    // collapse the reservation exists to prevent.
    return category.archived ? null : (
      <div className={styles.limitPlaceholder} aria-hidden="true" />
    );
  }
  return (
    <CategoryLimitSlot
      category={category}
      item={state.item}
      currency={state.currency}
    />
  );
}

interface CategoryLimitSlotProps {
  category: CategoryRead;
  item: LimitItem | undefined;
  /** `LimitsRead.currency` — the base `spent_minor` is denominated in. */
  currency: string;
}

/**
 * The budget slot for one expense category: the bar plus the write affordances.
 *
 * Affordance gating (C4, extended): Set/Edit only on a NON-ARCHIVED category —
 * the server answers 422 `CATEGORY_ARCHIVED`, and offering a button whose only
 * outcome is that error is not an affordance. An existing budget on a
 * since-archived category is still rendered (the server returns it) with Remove
 * available, so the user can clean it up.
 */
function CategoryLimitSlot({ category, item, currency }: CategoryLimitSlotProps) {
  const lang = useLang();
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | undefined>(undefined);
  const deleteLimit = useDeleteLimit();

  const confirmRemove = async () => {
    setRemoveError(undefined);
    try {
      await deleteLimit.mutateAsync({ categoryId: category.id });
      setRemoving(false);
    } catch (error) {
      setRemoveError(describeLimitError(error, lang).message);
    }
  };

  if (item === undefined) {
    // No budget on an archived category: setting one is exactly what the server
    // refuses, so there is nothing to offer here.
    if (category.archived) return null;
    return (
      <div className={styles.limitSlot}>
        <button
          type="button"
          className={styles.limitAction}
          // The visible label repeats on every row, so the accessible name names
          // the category — a button list is otherwise 19× "Set a budget".
          aria-label={t('limits.setBudgetFor', { name: category.name })}
          onClick={() => setEditing(true)}
        >
          {t('limits.setBudget')}
        </button>
        {editing ? (
          <LimitFormModal
            category={category}
            currency={currency}
            onClose={() => setEditing(false)}
          />
        ) : null}
      </div>
    );
  }

  const progress = limitProgress(item, currency);
  // The way out of a mismatch is a re-save: the PUT re-stamps the budget with the
  // current base currency (D15).
  const editLabel = t(progress.status === 'mismatch' ? 'limits.updateBudget' : 'common.edit');

  return (
    <div className={styles.limitSlot}>
      <LimitBar progress={progress} label={category.name} />
      <div className={styles.limitActions}>
        {category.archived ? null : (
          <button
            type="button"
            className={styles.limitAction}
            aria-label={t('limits.editBudgetFor', {
              action: editLabel,
              name: category.name,
            })}
            onClick={() => setEditing(true)}
          >
            {editLabel}
          </button>
        )}
        <button
          type="button"
          className={styles.limitDanger}
          aria-label={t('limits.removeBudgetFor', { name: category.name })}
          onClick={() => {
            setRemoveError(undefined);
            setRemoving(true);
          }}
        >
          {t('common.remove')}
        </button>
      </div>

      {editing ? (
        <LimitFormModal
          category={category}
          currency={currency}
          existing={{ minor: item.limit_minor, currency: item.limit_currency }}
          onClose={() => setEditing(false)}
        />
      ) : null}

      {removing ? (
        <ConfirmDialog
          title={t('limits.removeTitle')}
          message={t('limits.removeMessage', { name: category.name })}
          confirmLabel={t('common.remove')}
          pendingLabel={t('common.removing')}
          destructive
          isPending={deleteLimit.isPending}
          errorMessage={removeError}
          onConfirm={() => {
            void confirmRemove();
          }}
          onCancel={() => setRemoving(false)}
        />
      ) : null}
    </div>
  );
}
