import { formatMoney } from '@budget/shared';
import { useState } from 'react';

import { QueryStateNotice } from '../components/QueryStateNotice';
import { useGoals, type GoalRead } from '../data/goals';
import { GoalCard } from '../features/goals/GoalCard';
import { GoalFormModal } from '../features/goals/GoalFormModal';
import { queryPhase } from '../lib/queryPhase';
import styles from './GoalsPage.module.css';

type ModalState = { type: 'closed' } | { type: 'create' } | { type: 'edit'; goal: GoalRead };

export function GoalsPage() {
  // Genuine client state: a view preference, not server data.
  const [includeArchived, setIncludeArchived] = useState(false);
  const [modal, setModal] = useState<ModalState>({ type: 'closed' });

  const goalsQuery = useGoals(includeArchived);
  const phase = queryPhase(goalsQuery);
  const list = goalsQuery.data;

  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Goals</h1>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(event) => setIncludeArchived(event.target.checked)}
          />
          Show archived
        </label>
        <button
          type="button"
          className={styles.addButton}
          onClick={() => setModal({ type: 'create' })}
          // The create form needs the profile base currency (its default pick),
          // which arrives with the list response — AM-4/WD-6: never guessed.
          disabled={list === undefined}
        >
          New goal
        </button>
      </header>

      {phase === 'loading' ? (
        <div className={styles.skeletons} aria-hidden="true">
          <div className={styles.skeletonCard} />
          <div className={styles.skeletonCard} />
        </div>
      ) : phase === 'error' || phase === 'unreachable' ? (
        <QueryStateNotice
          phase={phase}
          message="Couldn't load your goals."
          onRetry={() => {
            void goalsQuery.refetch();
          }}
        />
      ) : list ? (
        <>
          <div className={styles.freeBalance}>
            {list.free_balance_minor > 0 ? (
              <p className={styles.freeBalanceLine}>
                Over the last 3 full months you had about{' '}
                <strong>{formatMoney(list.free_balance_minor, list.base_currency)}</strong> a
                month left over. That&apos;s what gets shared out below, top priority first.
              </p>
            ) : (
              <p className={styles.freeBalanceLine}>
                Over the last 3 full months you spent at least as much as you earned
                ({formatMoney(list.free_balance_minor, list.base_currency)} a month left
                over), so there&apos;s nothing to share out between goals yet.
              </p>
            )}
            {list.realism_unavailable ? (
              <p className={styles.notice} role="status">
                Some transactions in that window had no exchange rate and were left out, so
                this figure — and the pace estimates below — are incomplete.
              </p>
            ) : null}
          </div>

          {list.items.length === 0 ? (
            <div className={styles.empty}>
              <p className={styles.emptyTitle}>No goals yet.</p>
              <p className={styles.emptyBody}>
                Create one to see how much of your monthly surplus it would take and whether
                your deadline is realistic.
              </p>
              <button
                type="button"
                className={styles.addButton}
                onClick={() => setModal({ type: 'create' })}
              >
                New goal
              </button>
            </div>
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
