import type { components } from '@budget/api-client';
import { useState } from 'react';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useDeleteLimit, type LimitItem } from '../../data/limits';
import { LimitBar } from '../limits/LimitBar';
import { LimitFormModal } from '../limits/LimitFormModal';
import { limitProgress } from '../limits/limitProgress';
import { useLang, useT } from '../../i18n/context';
import { describeLimitError } from '../../lib/errors';
import { CategoryTransactionsModal } from './CategoryTransactionsModal';
import styles from './CategoryList.module.css';

type CategoryRead = components['schemas']['CategoryRead'];

/**
 * What the row knows about this month's budgets (W4).
 *
 * `hidden` is the FAILED read: the section-level notice above the groups already
 * says the budgets could not be loaded and offers the retry, so a per-row error
 * would repeat that message once per category (WR-6 / the UI-states table).
 * `loading` reserves room so the list does not shift when the query lands (see
 * `budgetView` for what is reserved and what is deliberately not).
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
 * What the row shows about a budget, as ONE value — the affordance in the row
 * line and the bar under it are two renderings of the same fact and must not be
 * decided in two places.
 *
 * The gates are unchanged from W4/C4: budgets are an EXPENSE concept (the server
 * answers `CATEGORY_NOT_EXPENSE` otherwise), and setting one on an ARCHIVED
 * category is a 422 (`CATEGORY_ARCHIVED`) — a button whose only outcome is that
 * error is not an affordance. An existing budget on a since-archived category is
 * still shown, with Remove, so it can be cleaned up.
 */
type BudgetView =
  | { kind: 'none' }
  | { kind: 'reserve' }
  | { kind: 'unset'; currency: string }
  | { kind: 'set'; item: LimitItem; currency: string };

function budgetView(category: CategoryRead, state: LimitSlotState): BudgetView {
  if (category.kind !== 'expense' || state.kind === 'hidden') return { kind: 'none' };
  if (state.kind === 'loading') {
    // Room is reserved only where something is CERTAIN to land, and only as much
    // as is certain: a non-archived expense row always ends up with either the
    // "+ Budget" pill or a bar, an archived one may end up with nothing at all.
    // What is reserved is the PILL'S WIDTH inside the row line, not a second line
    // — an unset budget no longer has one (task.md 1), so reserving a line would
    // recreate the double-height row this scope removes and then collapse it. The
    // price is that a row which turns out to HAVE a budget grows by the bar's
    // height when the query lands; budgets are the minority of categories, so
    // that jump is rarer than the permanent empty line the alternative costs.
    return category.archived ? { kind: 'none' } : { kind: 'reserve' };
  }
  if (state.item === undefined) {
    return category.archived ? { kind: 'none' } : { kind: 'unset', currency: state.currency };
  }
  return { kind: 'set', item: state.item, currency: state.currency };
}

/**
 * The pill's contents, shared by the button and its invisible reservation.
 *
 * The word is a span of its own because at phone widths it is dropped and the
 * pill becomes the bare "+" — see `.limitSetLabel` in the stylesheet for the
 * width arithmetic that makes that necessary. The reservation uses the same
 * markup, so it keeps reserving exactly what the button will take.
 */
function budgetPillLabel(label: string) {
  return (
    <>
      <span className={styles.limitSetIcon} aria-hidden="true">
        +
      </span>
      <span className={styles.limitSetLabel}>{label}</span>
    </>
  );
}

/**
 * A single category row. System categories (C4) are edit-gated: they render as a
 * non-interactive row with a "System" tag and no click affordance. User categories
 * render as a button that opens the edit modal.
 *
 * Since W4 the row is a WRAPPER: the category itself stays the same button/div,
 * and everything else sits beside it as a sibling — never inside, because a
 * button cannot nest in a button. The CARD (border, background, radius) is that
 * wrapper, so the budget belongs to the card that owns it; drawing the card on
 * `.row` is what used to leave the budget hanging under the list
 * (recurring-and-limits follow-up 2).
 *
 * category-popup-and-ui-polish: while no budget is set the whole row is ONE line
 * — "+ Budget" is a compact pill in the row's right-hand group, next to the
 * drill-down, instead of a second line of its own (task.md 1). A SET budget keeps
 * its second line: a bar with the numbers has nowhere else to go. The budget form
 * is owned HERE, not by either affordance, because both open the same one.
 *
 * The drill-down is a BUTTON that opens the category's operations over this
 * screen (task.md 2) — it used to navigate to /transactions, which traded the
 * whole category screen for one filtered list. That link still exists, inside the
 * window, for anyone who wants the full toolbox.
 */
export function CategoryRow({ category, onEdit, limit }: CategoryRowProps) {
  const t = useT();
  const [editingLimit, setEditingLimit] = useState(false);
  const [drilling, setDrilling] = useState(false);
  const budget = budgetView(category, limit);

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
      <div className={styles.rowLine}>
        {category.is_system ? (
          <div className={className}>{inner}</div>
        ) : (
          <button type="button" className={className} onClick={() => onEdit(category)}>
            {inner}
          </button>
        )}
        {/* The reservation is the PILL ITSELF, invisible: it is the only thing
            that is exactly as wide as the button that replaces it, in whichever
            language is on. */}
        {budget.kind === 'reserve' ? (
          <span
            className={`${styles.limitSetButton} ${styles.limitReserve}`}
            aria-hidden="true"
          >
            {budgetPillLabel(t('limits.setBudgetShort'))}
          </span>
        ) : null}
        {budget.kind === 'unset' ? (
          <button
            type="button"
            className={styles.limitSetButton}
            // The visible label repeats on every row, so the accessible name
            // names the category — a button list is otherwise 19× "Budget".
            // `title` carries the same sentence for the sighted pointer user,
            // who at phone widths sees only the "+".
            aria-label={t('limits.setBudgetFor', { name: category.name })}
            title={t('limits.setBudgetFor', { name: category.name })}
            onClick={() => setEditingLimit(true)}
          >
            {budgetPillLabel(t('limits.setBudgetShort'))}
          </button>
        ) : null}
        <button
          type="button"
          className={styles.drill}
          aria-label={t('categories.viewTransactionsFor', { name: category.name })}
          title={t('categories.viewTransactions')}
          onClick={() => setDrilling(true)}
        >
          <svg
            className={styles.drillIcon}
            viewBox="0 0 16 16"
            aria-hidden="true"
            focusable="false"
          >
            <path
              d="M2 3.5h12M2 8h12M2 12.5h8"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              fill="none"
            />
          </svg>
        </button>
      </div>

      {budget.kind === 'set' ? (
        <CategoryLimitBar
          category={category}
          item={budget.item}
          currency={budget.currency}
          onEdit={() => setEditingLimit(true)}
        />
      ) : null}

      {editingLimit && budget.kind !== 'none' && budget.kind !== 'reserve' ? (
        <LimitFormModal
          category={category}
          currency={budget.currency}
          existing={
            budget.kind === 'set'
              ? { minor: budget.item.limit_minor, currency: budget.item.limit_currency }
              : undefined
          }
          onClose={() => setEditingLimit(false)}
        />
      ) : null}

      {drilling ? (
        <CategoryTransactionsModal
          category={category}
          onClose={() => setDrilling(false)}
        />
      ) : null}
    </div>
  );
}

interface CategoryLimitBarProps {
  category: CategoryRead;
  item: LimitItem;
  /** `LimitsRead.currency` — the base `spent_minor` is denominated in. */
  currency: string;
  onEdit: () => void;
}

/**
 * The second line of a row that HAS a budget: the bar plus its two write
 * affordances. Edit only on a NON-ARCHIVED category (the server answers 422
 * `CATEGORY_ARCHIVED`); Remove always, so a budget left on a since-archived
 * category can be cleaned up.
 */
function CategoryLimitBar({ category, item, currency, onEdit }: CategoryLimitBarProps) {
  const lang = useLang();
  const t = useT();
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
            onClick={onEdit}
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
