import { formatMoney } from '@budget/shared';
import { useState } from 'react';

import { QueryStateNotice } from '../components/QueryStateNotice';
import { useGoals, type GoalRead } from '../data/goals';
import { GoalCard } from '../features/goals/GoalCard';
import { GoalFormModal } from '../features/goals/GoalFormModal';
import { useLocale, useT } from '../i18n/context';
import { queryPhase } from '../lib/queryPhase';
import styles from './GoalsPage.module.css';

type ModalState = { type: 'closed' } | { type: 'create' } | { type: 'edit'; goal: GoalRead };

export function GoalsPage() {
  const locale = useLocale();
  const t = useT();
  // Genuine client state: a view preference, not server data.
  const [includeArchived, setIncludeArchived] = useState(false);
  const [modal, setModal] = useState<ModalState>({ type: 'closed' });

  const goalsQuery = useGoals(includeArchived);
  const phase = queryPhase(goalsQuery);
  const list = goalsQuery.data;

  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>{t('goals.title')}</h1>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(event) => setIncludeArchived(event.target.checked)}
          />
          {t('goals.showArchived')}
        </label>
        <button
          type="button"
          className={styles.addButton}
          onClick={() => setModal({ type: 'create' })}
          // The create form needs the profile base currency (its default pick),
          // which arrives with the list response — AM-4/WD-6: never guessed.
          disabled={list === undefined}
        >
          {t('goals.newGoal')}
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
          message={t('goals.loadFailed')}
          onRetry={() => {
            void goalsQuery.refetch();
          }}
        />
      ) : list ? (
        <>
          <div className={styles.freeBalance}>
            {list.free_balance_minor > 0 ? (
              <p className={styles.freeBalanceLine}>
                {t('goals.freeBalancePrefix')}{' '}
                <strong>
                  {formatMoney(list.free_balance_minor, list.base_currency, { locale })}
                </strong>{' '}
                {t('goals.freeBalanceSuffix')}
              </p>
            ) : (
              <p className={styles.freeBalanceLine}>
                {t('goals.freeBalanceNone', {
                  amount: formatMoney(list.free_balance_minor, list.base_currency, {
                    locale,
                  }),
                })}
              </p>
            )}
            {list.realism_unavailable ? (
              <p className={styles.notice} role="status">
                {t('goals.realismUnavailable')}
              </p>
            ) : null}
          </div>

          {list.items.length === 0 ? (
            <div className={styles.empty}>
              <p className={styles.emptyTitle}>{t('goals.emptyTitle')}</p>
              <p className={styles.emptyBody}>{t('goals.emptyBody')}</p>
              <button
                type="button"
                className={styles.addButton}
                onClick={() => setModal({ type: 'create' })}
              >
                {t('goals.newGoal')}
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
