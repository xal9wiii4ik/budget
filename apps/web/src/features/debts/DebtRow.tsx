import { formatApiDate, formatMoney } from '@budget/shared';

import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import type { DebtRead } from '../../data/debts';
import { useLocale, useT } from '../../i18n/context';
import { debtRowState, type DebtBadge } from './debtGroups';
import styles from './DebtList.module.css';

interface DebtRowProps {
  debt: DebtRead;
  /** `todayApiDateUtc()` from the screen — the overdue compare. See debtGroups. */
  today: string;
  onEdit: (debt: DebtRead) => void;
  onRecordRepayment: (debt: DebtRead) => void;
  onHistory: (debt: DebtRead) => void;
  onDelete: (debt: DebtRead) => void;
}

const BADGE_KEY = {
  overdue: 'debts.badgeOverdue',
  closed: 'debts.badgeClosed',
} as const satisfies Record<DebtBadge, string>;

/* Tone is a TONE, never the sentence: the badge's own text says what it means. A
   missed deadline is a caveat, a settled debt is quiet. */
const BADGE_TONE = {
  overdue: 'warning',
  closed: 'neutral',
} as const satisfies Record<DebtBadge, 'warning' | 'neutral'>;

/**
 * One debt: what is STILL OWED, next to the original amount and what has come
 * back. Three labelled figures, never a total and never a subtraction — all
 * three are server fields in the DEBT's currency (`remaining_minor` is the
 * server's own difference, computed per read under the same query that derives
 * `status`).
 *
 * Not a single big `<button>` like AccountRow: a debt has four things you can do
 * to it, so the row is an article with its own actions and the counterparty is a
 * heading rather than button text (the DepositRow shape).
 */
export function DebtRow({
  debt,
  today,
  onEdit,
  onRecordRepayment,
  onHistory,
  onDelete,
}: DebtRowProps) {
  const locale = useLocale();
  const t = useT();
  const state = debtRowState(debt, today);
  const settled = debt.status === 'closed';

  const rowClass = [
    styles.row,
    settled ? styles.settled : null,
    state.isOverdue ? styles.overdue : null,
  ]
    .filter(Boolean)
    .join(' ');

  const remainingClass = settled
    ? styles.remainingSettled
    : debt.direction === 'lent'
      ? styles.remainingLent
      : styles.remainingBorrowed;

  return (
    <article className={rowClass}>
      <header className={styles.head}>
        {/* The counterparty is the user's own text — never translated. */}
        <h3 className={styles.name}>{debt.counterparty}</h3>
        {state.badges.length > 0 ? (
          <span className={styles.badges}>
            {state.badges.map((badge) => (
              // Text badges, never colour alone.
              <Badge tone={BADGE_TONE[badge]} key={badge}>
                {t(BADGE_KEY[badge])}
              </Badge>
            ))}
          </span>
        ) : null}
      </header>

      <dl className={styles.figures}>
        <div className={styles.figure}>
          <dt className={styles.figureLabel}>{t('debts.remaining')}</dt>
          <dd className={`${styles.figureValue} ${remainingClass} tnum`}>
            {formatMoney(debt.remaining_minor, debt.currency, { locale })}
          </dd>
        </div>
        <div className={styles.figure}>
          <dt className={styles.figureLabel}>{t('debts.principal')}</dt>
          <dd className={`${styles.figureValue} ${styles.secondary} tnum`}>
            {formatMoney(debt.principal_minor, debt.currency, { locale })}
          </dd>
        </div>
        <div className={styles.figure}>
          <dt className={styles.figureLabel}>{t('debts.repaid')}</dt>
          <dd className={`${styles.figureValue} ${styles.secondary} tnum`}>
            {formatMoney(debt.repaid_minor, debt.currency, { locale })}
          </dd>
        </div>
      </dl>

      <p className={state.isOverdue ? `${styles.meta} ${styles.metaOverdue}` : styles.meta}>
        {t('debts.opened', { date: formatApiDate(debt.opened_on, { locale }) })}
        {' · '}
        {debt.due_on === null
          ? t('debts.noDue')
          : t(state.isOverdue ? 'debts.overdueSince' : 'debts.due', {
              date: formatApiDate(debt.due_on, { locale }),
            })}
        {/* `closed_on` is the date of the LAST repayment, decided server-side. */}
        {settled && debt.closed_on !== null
          ? ` · ${t('debts.closedOn', { date: formatApiDate(debt.closed_on, { locale }) })}`
          : ''}
        {debt.repayments_count > 0
          ? ` · ${t('debts.repaymentsCount', { count: debt.repayments_count })}`
          : ''}
      </p>

      {/* The user's own note — never translated. */}
      {debt.note ? <p className={styles.note}>{debt.note}</p> : null}

      <div className={styles.actions}>
        {/* A settled debt owes nothing, so the affordance is absent rather than
            dead: a repayment on it is the server's EXCEEDS_REMAINING refusal. */}
        {state.canRecordRepayment ? (
          <Button size="sm" variant="primary" onClick={() => onRecordRepayment(debt)}>
            {t('debts.recordRepayment')}
          </Button>
        ) : null}
        <Button size="sm" onClick={() => onEdit(debt)}>
          {t('common.edit')}
        </Button>
        {/* The history is the DETAIL response's embedded repayments, so there is
            nothing to open before the first one exists. */}
        {debt.repayments_count > 0 ? (
          <Button size="sm" onClick={() => onHistory(debt)}>
            {t('debts.history')}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => onDelete(debt)}>
          {t('common.delete')}
        </Button>
      </div>
    </article>
  );
}
