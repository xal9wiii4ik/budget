import { formatApiDate, formatMoney } from '@budget/shared';
import { useState } from 'react';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import {
  useContributions,
  useDeleteContribution,
  type ContributionRead,
  type GoalRead,
} from '../../data/goals';
import { useLang, useLocale, useT } from '../../i18n/context';
import { describeContributionError } from '../../lib/errors';
import styles from './ContributionList.module.css';

interface ContributionListProps {
  goal: GoalRead;
}

/**
 * The goal's ledger, newest first, inside the card's expanded section — the query
 * fires when this component mounts (i.e. on expand), so a collapsed card costs
 * nothing.
 *
 * Rows are shown exactly as stored: a withdrawal is a negative amount and a
 * FUTURE-dated contribution is an ordinary row (PM decision — allowed, never
 * hidden). Amounts decode with the GOAL's currency (AM-5).
 */
export function ContributionList({ goal }: ContributionListProps) {
  const lang = useLang();
  const locale = useLocale();
  const t = useT();
  const contributions = useContributions(goal.id);
  const deleteContribution = useDeleteContribution(goal.id);
  const [confirming, setConfirming] = useState<ContributionRead | null>(null);
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined);

  const items = contributions.data?.pages.flatMap((page) => page.items) ?? [];

  const confirmDelete = async () => {
    if (!confirming) return;
    setDeleteError(undefined);
    try {
      await deleteContribution.mutateAsync({ contributionId: confirming.id });
      setConfirming(null);
    } catch (error) {
      // Includes CONTRIBUTION_EXCEEDS_SAVED: deleting a positive row is a
      // withdrawal in disguise and the server refuses if it would go below zero.
      setDeleteError(describeContributionError(error, lang).message);
    }
  };

  if (contributions.isPending) {
    return (
      <div className={styles.skeletons} aria-hidden="true">
        <div className={styles.skeletonRow} />
        <div className={styles.skeletonRow} />
      </div>
    );
  }

  if (contributions.isError) {
    return (
      <p className={styles.error} role="alert">
        {t('contributionList.loadFailed')}
        <button type="button" className={styles.retry} onClick={() => contributions.refetch()}>
          {t('common.retry')}
        </button>
      </p>
    );
  }

  if (items.length === 0) {
    return (
      <p className={styles.empty}>{t('contributionList.empty')}</p>
    );
  }

  return (
    <div className={styles.wrapper}>
      <ul className={styles.list}>
        {items.map((item) => (
          <li key={item.id} className={styles.row}>
            <span className={styles.date}>{formatApiDate(item.occurred_at, { locale })}</span>
            <span
              className={
                item.amount_minor < 0
                  ? `${styles.amount} ${styles.withdrawal}`
                  : styles.amount
              }
            >
              {formatMoney(item.amount_minor, goal.currency, { locale })}
            </span>
            <span className={styles.note}>{item.note ?? ''}</span>
            <button
              type="button"
              className={styles.delete}
              onClick={() => {
                setDeleteError(undefined);
                setConfirming(item);
              }}
            >
              {t('common.delete')}
            </button>
          </li>
        ))}
      </ul>

      {contributions.hasNextPage ? (
        <button
          type="button"
          className={styles.loadMore}
          onClick={() => contributions.fetchNextPage()}
          disabled={contributions.isFetchingNextPage}
        >
          {t(contributions.isFetchingNextPage ? 'common.loading' : 'common.loadMore')}
        </button>
      ) : null}

      {confirming ? (
        <ConfirmDialog
          title={t('contributionList.deleteTitle')}
          message={t('contributionList.deleteMessage', {
            amount: formatMoney(confirming.amount_minor, goal.currency, { locale }),
            date: formatApiDate(confirming.occurred_at, { locale }),
          })}
          confirmLabel={t('common.delete')}
          pendingLabel={t('common.deleting')}
          destructive
          isPending={deleteContribution.isPending}
          errorMessage={deleteError}
          onConfirm={confirmDelete}
          onCancel={() => setConfirming(null)}
        />
      ) : null}
    </div>
  );
}
