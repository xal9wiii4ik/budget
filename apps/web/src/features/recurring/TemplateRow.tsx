import { formatApiDate, formatMoney } from '@budget/shared';
import type { components } from '@budget/api-client';

import { periodicityLabel } from './periodicity';
import { templateStatus } from './templateStatus';
import type { RecurringTemplateRead } from '../../data/recurring';
import { useLocale, useT } from '../../i18n/context';
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
  const t = useT();
  const isExpense = template.kind === 'expense';
  const signedMinor = isExpense ? -template.amount_minor : template.amount_minor;
  const categoryName =
    template.category_id === null
      ? t('common.uncategorized')
      : (category?.name ?? t('common.unknownCategory'));
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
              {categoryName} · {periodicityLabel(template, t, locale)}
            </span>
          </div>
        </div>
        <span className={`${styles.amount} ${isExpense ? styles.expense : styles.income}`}>
          {/* T8′: the template's amount is denominated in the template's OWN
              stored currency — never the profile base. */}
          {formatMoney(signedMinor, template.currency, { locale })}
        </span>
      </div>

      <div className={styles.statusLine}>
        {status.status === 'active' ? (
          <span className={styles.next}>
            {t('recurring.nextOn', { date: formatApiDate(status.nextDueOn, { locale }) })}
          </span>
        ) : null}
        {status.status === 'paused' ? (
          <>
            <span className={`${styles.badge} ${styles.badgePaused}`}>
              {t('recurring.paused')}
            </span>
            {/* D6, said once so resuming is never a surprise. */}
            <span className={styles.statusNote}>{t('recurring.pausedNote')}</span>
          </>
        ) : null}
        {status.status === 'ended' ? (
          <>
            <span className={`${styles.badge} ${styles.badgeEnded}`}>
              {t('recurring.ended')}
            </span>
            {status.endDate !== null ? (
              <span className={styles.statusNote}>
                {t('recurring.endedOn', { date: formatApiDate(status.endDate, { locale }) })}
              </span>
            ) : null}
          </>
        ) : null}
      </div>

      <div className={styles.actions}>
        <button type="button" className={styles.action} onClick={() => onEdit(template)}>
          {t('common.edit')}
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
          {t(template.paused ? 'recurring.resume' : 'recurring.pause')}
        </button>
        <button
          type="button"
          className={`${styles.action} ${styles.destructive}`}
          onClick={() => onDelete(template)}
        >
          {t('common.delete')}
        </button>
      </div>
    </li>
  );
}
