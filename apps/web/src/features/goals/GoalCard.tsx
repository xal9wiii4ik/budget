import { formatApiDate, formatMoney } from '@budget/shared';
import { useState } from 'react';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useDeleteGoal, useUpdateGoal, type GoalRead } from '../../data/goals';
import { useLang, useLocale } from '../../i18n/context';
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
        {goal.completed ? <span className={styles.badgeDone}>Reached</span> : null}
        {goal.archived ? <span className={styles.badgeMuted}>Archived</span> : null}
        <span className={styles.spacer} />
        <span className={styles.priority}>Priority {goal.priority}</span>
      </header>

      <div className={styles.amounts}>
        <strong className={styles.saved}>{formatMoney(goal.saved_minor, goal.currency)}</strong>
        <span className={styles.target}>
          of {formatMoney(goal.target_minor, goal.currency)}
        </span>
      </div>
      <div
        className={styles.bar}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={goal.target_minor}
        aria-valuenow={goal.saved_minor}
        // Minor units are meaningless read aloud — announce the formatted pair.
        aria-valuetext={`${formatMoney(goal.saved_minor, goal.currency)} of ${formatMoney(goal.target_minor, goal.currency)}`}
        aria-label={`${goal.name} progress`}
      >
        <div className={styles.barFill} style={{ width: `${progressRatio * 100}%` }} />
      </div>

      <p className={styles.deadline}>
        {goal.deadline ? `Deadline ${formatApiDate(goal.deadline, { locale })}` : 'No deadline'}
      </p>

      <div className={styles.realism}>
        {realism.status === 'completed' ? (
          <p className={styles.good}>You&apos;ve reached this goal.</p>
        ) : null}

        {realism.status === 'unavailable' ? (
          <p className={styles.warn} role="status">
            Can&apos;t check whether this is realistic — no exchange rate for{' '}
            {realism.currency} right now. Your saved and target amounts are unaffected.
          </p>
        ) : null}

        {realism.status === 'no-deadline' ? (
          <p className={styles.muted}>
            No deadline set, so there&apos;s no monthly target — add one to see whether
            you&apos;re on pace.
          </p>
        ) : null}

        {realism.status === 'on-track' ? (
          <p className={styles.good}>
            On track: {formatMoney(realism.monthlyNeededMinor, goal.currency)} a month gets
            you there.
          </p>
        ) : null}

        {realism.status === 'behind-movable' ? (
          <div className={styles.warn}>
            <p className={styles.warnTitle}>
              Not realistic at your current pace — this deadline needs{' '}
              {formatMoney(realism.monthlyNeededMinor, goal.currency)} a month.
            </p>
            <p>
              At your free balance it takes about {realism.monthsToTarget} month
              {realism.monthsToTarget === 1 ? '' : 's'}
              {realism.suggestedDeadline
                ? ` — move the deadline to ${formatApiDate(realism.suggestedDeadline, { locale })}?`
                : '.'}
            </p>
          </div>
        ) : null}

        {realism.status === 'behind-unreachable' ? (
          <div className={styles.warn}>
            <p className={styles.warnTitle}>
              Not realistic at your current pace — this deadline needs{' '}
              {formatMoney(realism.monthlyNeededMinor, goal.currency)} a month.
            </p>
            <p>
              Your free balance doesn&apos;t cover this goal right now, so we can&apos;t
              estimate when you&apos;d get there.
            </p>
          </div>
        ) : null}

        {/* The waterfall share, in the PROFILE BASE currency — a different currency
            from everything above it, formatted with its own. */}
        {goal.allocated_monthly_minor > 0 ? (
          <p className={styles.muted}>
            {formatMoney(goal.allocated_monthly_minor, goal.base_currency)} a month of your
            free balance is going here.
          </p>
        ) : !goal.archived && !goal.completed && !goal.realism_unavailable ? (
          <p className={styles.muted}>
            None of your free balance is going here right now.
          </p>
        ) : null}
      </div>

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.primaryAction}
          onClick={() => setContributing(true)}
        >
          Add or withdraw
        </button>
        <button
          type="button"
          className={styles.action}
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          aria-controls={`goal-history-${goal.id}`}
        >
          {expanded ? 'Hide history' : 'History & progress'}
        </button>
        <span className={styles.spacer} />
        <button type="button" className={styles.action} onClick={onEdit}>
          Edit
        </button>
        <button
          type="button"
          className={styles.action}
          onClick={() => {
            setActionError(undefined);
            setDialog('archive');
          }}
        >
          {goal.archived ? 'Unarchive' : 'Archive'}
        </button>
        <button
          type="button"
          className={styles.danger}
          onClick={() => {
            setActionError(undefined);
            setDialog('delete');
          }}
        >
          Delete
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
          title={goal.archived ? 'Unarchive goal' : 'Archive goal'}
          message={
            goal.archived
              ? `Bring "${goal.name}" back? It will share your free balance again.`
              : `Archive "${goal.name}"? Its history is kept, but it stops taking a share of your free balance.`
          }
          confirmLabel={goal.archived ? 'Unarchive' : 'Archive'}
          pendingLabel="Saving…"
          isPending={updateGoal.isPending}
          errorMessage={actionError}
          onConfirm={confirmArchive}
          onCancel={() => setDialog(null)}
        />
      ) : null}

      {dialog === 'delete' ? (
        <ConfirmDialog
          title="Delete goal"
          message={`Delete "${goal.name}"? Every contribution recorded against it is deleted too. This can't be undone — archive it instead if you want to keep the history.`}
          confirmLabel="Delete"
          pendingLabel="Deleting…"
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
