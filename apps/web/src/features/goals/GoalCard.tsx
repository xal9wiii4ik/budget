import { formatApiDate, formatMoney } from '@budget/shared';
import { useState } from 'react';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useDeleteGoal, useUpdateGoal, type GoalRead } from '../../data/goals';
import { useLang, useLocale, useT } from '../../i18n/context';
import { describeGoalError } from '../../lib/errors';
import { ContributionList } from './ContributionList';
import { ContributionModal } from './ContributionModal';
import { GoalProgressChart } from './GoalProgressChart';
import { realismContent } from './realism';
import styles from './GoalCard.module.css';

interface GoalCardProps {
  goal: GoalRead;
  onEdit: () => void;
}

type CardDialog = 'archive' | 'delete' | null;

/**
 * One goal. Every number on this card is a SERVER field (D12) formatted through
 * the shared helpers, and the card carries TWO currencies at once (T4/T8'):
 *   goal.currency       — target / saved / monthly needed / contributions
 *   goal.base_currency  — allocated_monthly_minor, a share of the base-currency
 *                         free balance (AM-4 discloses which currency that is)
 * Each field is formatted with ITS OWN currency; neither is ever a fallback for
 * the other (AM-5).
 */
export function GoalCard({ goal, onEdit }: GoalCardProps) {
  const lang = useLang();
  const locale = useLocale();
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [contributing, setContributing] = useState(false);
  const [dialog, setDialog] = useState<CardDialog>(null);
  const [actionError, setActionError] = useState<string | undefined>(undefined);

  const updateGoal = useUpdateGoal();
  const deleteGoal = useDeleteGoal();

  const realism = realismContent(goal);

  // Presentation geometry, NOT money math: a clamped ratio used as a CSS width.
  // No percentage is ever shown as a number. `target_minor >= 1` server-side, but
  // the guard keeps a hypothetical 0 from producing a NaN width.
  const progressRatio =
    goal.target_minor > 0
      ? Math.max(0, Math.min(1, goal.saved_minor / goal.target_minor))
      : 0;

  const confirmArchive = async () => {
    setActionError(undefined);
    try {
      await updateGoal.mutateAsync({ id: goal.id, body: { archived: !goal.archived } });
      setDialog(null);
    } catch (error) {
      setActionError(describeGoalError(error, lang).message);
    }
  };

  const confirmDelete = async () => {
    setActionError(undefined);
    try {
      await deleteGoal.mutateAsync({ id: goal.id });
      setDialog(null);
    } catch (error) {
      setActionError(describeGoalError(error, lang).message);
    }
  };

  return (
    <li className={goal.archived ? `${styles.card} ${styles.archived}` : styles.card}>
      <header className={styles.header}>
        <h2 className={styles.name}>{goal.name}</h2>
        {goal.completed ? (
          <span className={styles.badgeDone}>{t('goalCard.reached')}</span>
        ) : null}
        {goal.archived ? (
          <span className={styles.badgeMuted}>{t('common.archivedTag')}</span>
        ) : null}
        <span className={styles.spacer} />
        <span className={styles.priority}>
          {t('goalCard.priority', { value: goal.priority })}
        </span>
      </header>

      <div className={styles.amounts}>
        <strong className={styles.saved}>
          {formatMoney(goal.saved_minor, goal.currency, { locale })}
        </strong>
        <span className={styles.target}>
          {t('goalCard.ofTarget', {
            target: formatMoney(goal.target_minor, goal.currency, { locale }),
          })}
        </span>
      </div>
      <div
        className={styles.bar}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={goal.target_minor}
        aria-valuenow={goal.saved_minor}
        // Minor units are meaningless read aloud — announce the formatted pair.
        aria-valuetext={t('goalCard.pair', {
          saved: formatMoney(goal.saved_minor, goal.currency, { locale }),
          target: formatMoney(goal.target_minor, goal.currency, { locale }),
        })}
        aria-label={t('goalCard.progressAria', { name: goal.name })}
      >
        <div className={styles.barFill} style={{ width: `${progressRatio * 100}%` }} />
      </div>

      <p className={styles.deadline}>
        {goal.deadline
          ? t('goalCard.deadline', { date: formatApiDate(goal.deadline, { locale }) })
          : t('goalCard.noDeadline')}
      </p>

      <div className={styles.realism}>
        {realism.status === 'completed' ? (
          <p className={styles.good}>{t('goalCard.completed')}</p>
        ) : null}

        {realism.status === 'unavailable' ? (
          <p className={styles.warn} role="status">
            {t('goalCard.realismUnavailable', { currency: realism.currency })}
          </p>
        ) : null}

        {realism.status === 'no-deadline' ? (
          <p className={styles.muted}>{t('goalCard.noDeadlineHint')}</p>
        ) : null}

        {realism.status === 'on-track' ? (
          <p className={styles.good}>
            {t('goalCard.onTrack', {
              amount: formatMoney(realism.monthlyNeededMinor, goal.currency, { locale }),
            })}
          </p>
        ) : null}

        {realism.status === 'behind-movable' ? (
          <div className={styles.warn}>
            <p className={styles.warnTitle}>
              {t('goalCard.behindTitle', {
                amount: formatMoney(realism.monthlyNeededMinor, goal.currency, { locale }),
              })}
            </p>
            <p>
              {/* The months phrase is a PLURAL entry (ru needs one/few/many); the
                  sentence it is wrapped in depends on whether the server sent a
                  suggested deadline. */}
              {realism.suggestedDeadline
                ? t('goalCard.monthsWithSuggestion', {
                    months: t('goalCard.monthsToTarget', { count: realism.monthsToTarget }),
                    date: formatApiDate(realism.suggestedDeadline, { locale }),
                  })
                : t('goalCard.monthsPlain', {
                    months: t('goalCard.monthsToTarget', { count: realism.monthsToTarget }),
                  })}
            </p>
          </div>
        ) : null}

        {realism.status === 'behind-unreachable' ? (
          <div className={styles.warn}>
            <p className={styles.warnTitle}>
              {t('goalCard.behindTitle', {
                amount: formatMoney(realism.monthlyNeededMinor, goal.currency, { locale }),
              })}
            </p>
            <p>{t('goalCard.behindUnreachable')}</p>
          </div>
        ) : null}

        {/* The waterfall share, in the PROFILE BASE currency — a different currency
            from everything above it, formatted with its own. */}
        {goal.allocated_monthly_minor > 0 ? (
          <p className={styles.muted}>
            {t('goalCard.allocated', {
              amount: formatMoney(goal.allocated_monthly_minor, goal.base_currency, {
                locale,
              }),
            })}
          </p>
        ) : !goal.archived && !goal.completed && !goal.realism_unavailable ? (
          <p className={styles.muted}>{t('goalCard.noAllocation')}</p>
        ) : null}
      </div>

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.primaryAction}
          onClick={() => setContributing(true)}
        >
          {t('goalCard.addOrWithdraw')}
        </button>
        <button
          type="button"
          className={styles.action}
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          aria-controls={`goal-history-${goal.id}`}
        >
          {t(expanded ? 'goalCard.hideHistory' : 'goalCard.showHistory')}
        </button>
        <span className={styles.spacer} />
        <button type="button" className={styles.action} onClick={onEdit}>
          {t('common.edit')}
        </button>
        <button
          type="button"
          className={styles.action}
          onClick={() => {
            setActionError(undefined);
            setDialog('archive');
          }}
        >
          {t(goal.archived ? 'common.unarchive' : 'common.archive')}
        </button>
        <button
          type="button"
          className={styles.danger}
          onClick={() => {
            setActionError(undefined);
            setDialog('delete');
          }}
        >
          {t('common.delete')}
        </button>
      </div>

      {expanded ? (
        <section className={styles.history} id={`goal-history-${goal.id}`}>
          <GoalProgressChart goal={goal} />
          <ContributionList goal={goal} />
        </section>
      ) : null}

      {contributing ? (
        <ContributionModal goal={goal} onClose={() => setContributing(false)} />
      ) : null}

      {dialog === 'archive' ? (
        <ConfirmDialog
          title={t(goal.archived ? 'goalCard.unarchiveTitle' : 'goalCard.archiveTitle')}
          message={t(
            goal.archived ? 'goalCard.unarchiveMessage' : 'goalCard.archiveMessage',
            { name: goal.name },
          )}
          confirmLabel={t(goal.archived ? 'common.unarchive' : 'common.archive')}
          pendingLabel={t('common.saving')}
          isPending={updateGoal.isPending}
          errorMessage={actionError}
          onConfirm={confirmArchive}
          onCancel={() => setDialog(null)}
        />
      ) : null}

      {dialog === 'delete' ? (
        <ConfirmDialog
          title={t('goalCard.deleteTitle')}
          message={t('goalCard.deleteMessage', { name: goal.name })}
          confirmLabel={t('common.delete')}
          pendingLabel={t('common.deleting')}
          destructive
          isPending={deleteGoal.isPending}
          errorMessage={actionError}
          onConfirm={confirmDelete}
          onCancel={() => setDialog(null)}
        />
      ) : null}
    </li>
  );
}
