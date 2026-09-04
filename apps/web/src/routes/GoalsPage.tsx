import { useState } from 'react';

import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { PageHeader } from '../components/PageHeader';
import { QueryStateNotice } from '../components/QueryStateNotice';
import { useGoals, type GoalRead } from '../data/goals';
import { FreeBalanceSummary } from '../features/goals/FreeBalanceSummary';
import { GoalCard } from '../features/goals/GoalCard';
import { GoalFormModal } from '../features/goals/GoalFormModal';
import { useT } from '../i18n/context';
import { queryPhase } from '../lib/queryPhase';
import styles from './GoalsPage.module.css';

type ModalState = { type: 'closed' } | { type: 'create' } | { type: 'edit'; goal: GoalRead };

export function GoalsPage() {
  const t = useT();
  // Genuine client state: a view preference, not server data.
  const [includeArchived, setIncludeArchived] = useState(false);
  const [modal, setModal] = useState<ModalState>({ type: 'closed' });

  const goalsQuery = useGoals(includeArchived);
  const phase = queryPhase(goalsQuery);
  const list = goalsQuery.data;

  return (
    <section className={styles.page}>
      <PageHeader
        className={styles.header}
        title={t('goals.title')}
        actions={
          <>
            <label className={styles.toggle}>
              <input
                type="checkbox"
                checked={includeArchived}
                onChange={(event) => setIncludeArchived(event.target.checked)}
              />
              {t('goals.showArchived')}
            </label>
            <Button
              variant="primary"
              onClick={() => setModal({ type: 'create' })}
              // The create form needs the profile base currency (its default pick),
              // which arrives with the list response — AM-4/WD-6: never guessed.
              disabled={list === undefined}
            >
              {t('goals.newGoal')}
            </Button>
          </>
        }
      />

      {phase === 'loading' ? (
        <div className={styles.skeletons} aria-hidden="true">
          <div className={styles.skeletonCard} />
          <div className={styles.skeletonCard} />
        </div>
      ) : phase === 'error' || phase === 'unreachable' ? (
        <QueryStateNotice
          phase={phase}
          message={t('goals.loadFailed')}
          onRetry={() => {
            void goalsQuery.refetch();
          }}
        />
      ) : list ? (
        <>
          <div className={styles.freeBalance}>
            {/* What the number MEANS depends on what the server could compute it
                from (D2) — the whole switch, incl. the month window, lives in the
                component. Never rendered in a loading or error arm: it would be a
                claim about numbers that are not on screen. */}
            <FreeBalanceSummary list={list} />
            {list.realism_unavailable ? (
              <p className={styles.notice} role="status">
                {t('goals.realismUnavailable')}
              </p>
            ) : null}
          </div>

          {list.items.length === 0 ? (
            <EmptyState
              title={t('goals.emptyTitle')}
              description={t('goals.emptyBody')}
              actions={
                <Button variant="primary" onClick={() => setModal({ type: 'create' })}>
                  {t('goals.newGoal')}
                </Button>
              }
            />
          ) : (
            <ul className={styles.list}>
              {list.items.map((goal) => (
                <GoalCard
                  key={goal.id}
                  goal={goal}
                  onEdit={() => setModal({ type: 'edit', goal })}
                />
              ))}
            </ul>
          )}
        </>
      ) : null}

      {modal.type === 'create' && list ? (
        <GoalFormModal
          baseCurrency={list.base_currency}
          onClose={() => setModal({ type: 'closed' })}
        />
      ) : null}
      {modal.type === 'edit' && list ? (
        <GoalFormModal
          key={modal.goal.id}
          goal={modal.goal}
          baseCurrency={list.base_currency}
          onClose={() => setModal({ type: 'closed' })}
        />
      ) : null}
    </section>
  );
}
