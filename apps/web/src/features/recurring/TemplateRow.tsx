import { formatApiDate, formatMoney } from '@budget/shared';
import type { components } from '@budget/api-client';

import { periodicityLabel } from './periodicity';
import { templateStatus } from './templateStatus';
import type { RecurringTemplateRead } from '../../data/recurring';
import { useLocale } from '../../i18n/context';
import styles from './TemplateList.module.css';

type CategoryRead = components['schemas']['CategoryRead'];

interface TemplateRowProps {
  template: RecurringTemplateRead;
  category: CategoryRead | undefined;
  isPausePending: boolean;
  onEdit: (template: RecurringTemplateRead) => void;
  onTogglePause: (template: RecurringTemplateRead) => void;
  onDelete: (template: RecurringTemplateRead) => void;
}

/**
 * One template. Unlike a transaction row this is NOT a single button: it carries
 * three distinct actions (Edit, Pause/Resume, Delete), so the row is a container
 * and each action is a real `<button>`.
 *
 * Every date on it is a SERVER field rendered verbatim (R2) — `next_due_on` for
 * the active arm, `end_date` for the ended one. Nothing here computes a due date,
 * clamps a day, or compares anything to today.
 */
export function TemplateRow({
  template,
  category,
  isPausePending,
  onEdit,
  onTogglePause,
  onDelete,
}: TemplateRowProps) {
  const locale = useLocale();
  const isExpense = template.kind === 'expense';
  const signedMinor = isExpense ? -template.amount_minor : template.amount_minor;
  const categoryName =
    template.category_id === null ? 'Uncategorized' : (category?.name ?? 'Unknown category');
  const status = templateStatus(template);

  return (
    <li className={styles.row}>
      <div className={styles.main}>
        <div className={styles.identity}>
          <span className={styles.icon} aria-hidden="true">
            {category?.icon ?? '•'}
          </span>
          <div className={styles.details}>
            <span className={styles.name}>{template.name}</span>
            <span className={styles.meta}>
              {categoryName} · {periodicityLabel(template)}
            </span>
          </div>
        </div>
        <span className={`${styles.amount} ${isExpense ? styles.expense : styles.income}`}>
          {/* T8′: the template's amount is denominated in the template's OWN
              stored currency — never the profile base. */}
          {formatMoney(signedMinor, template.currency)}
        </span>
      </div>

      <div className={styles.statusLine}>
        {status.status === 'active' ? (
          <span className={styles.next}>Next on {formatApiDate(status.nextDueOn, { locale })}</span>
        ) : null}
        {status.status === 'paused' ? (
          <>
            <span className={`${styles.badge} ${styles.badgePaused}`}>Paused</span>
            {/* D6, said once so resuming is never a surprise. */}
            <span className={styles.statusNote}>
              Nothing is created while paused, and skipped dates are not backfilled when you
              resume.
            </span>
          </>
        ) : null}
        {status.status === 'ended' ? (
          <>
            <span className={`${styles.badge} ${styles.badgeEnded}`}>Ended</span>
            {status.endDate !== null ? (
              <span className={styles.statusNote}>Ended {formatApiDate(status.endDate, { locale })}</span>
            ) : null}
          </>
        ) : null}
      </div>

      <div className={styles.actions}>
        <button type="button" className={styles.action} onClick={() => onEdit(template)}>
          Edit
        </button>
        {/* Pause/Resume is reversible and self-describing, so it takes no
            confirmation — and it is its own one-field PATCH, never part of a
            save (WR-9). */}
        <button
          type="button"
          className={styles.action}
          onClick={() => onTogglePause(template)}
          disabled={isPausePending}
        >
          {template.paused ? 'Resume' : 'Pause'}
        </button>
        <button
          type="button"
          className={`${styles.action} ${styles.destructive}`}
          onClick={() => onDelete(template)}
        >
          Delete
        </button>
      </div>
    </li>
  );
}
