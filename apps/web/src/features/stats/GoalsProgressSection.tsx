import { formatMoney } from '@budget/shared';
import { Link } from 'react-router';

import { QueryStateNotice } from '../../components/QueryStateNotice';
import { useGoals } from '../../data/goals';
import { queryPhase } from '../../lib/queryPhase';
import styles from './GoalsProgressSection.module.css';

/**
 * Goals at a glance on the stats screen.
 *
 * Reuses the EXISTING `useGoals(false)` query — no new endpoint, no new query
 * key, no second assembler. Goals progress is deliberately not re-served by
 * /stats (server D4): a second source for the same numbers could only drift from
 * what the goals screen shows. Realism, the waterfall and the per-goal series
 * stay on /goals — one assembler, one presentation.
 *
 * Two currencies never mix: every amount here is the GOAL's own currency.
 */
export function GoalsProgressSection() {
  const goalsQuery = useGoals(false);
  const phase = queryPhase(goalsQuery);

  return (
    <section className={styles.section} aria-labelledby="goals-heading">
      <header className={styles.header}>
        <h2 id="goals-heading" className={styles.heading}>
          Goals
        </h2>
        <Link className={styles.link} to="/goals">
          Open goals
        </Link>
      </header>

      {phase === 'error' || phase === 'unreachable' ? (
        <QueryStateNotice
          phase={phase}
          message="Couldn't load your goals."
          compact
          onRetry={() => {
            void goalsQuery.refetch();
          }}
        />
      ) : !goalsQuery.isSuccess ? (
        // 'loading' — the failing phases returned above; the query's own
        // discriminant is what keeps `goalsQuery.data` typed below.
        <div className={styles.skeleton} aria-hidden="true" />
      ) : goalsQuery.data.items.length === 0 ? (
        <p className={styles.empty}>
          No goals yet. <Link to="/goals">Create one</Link> to see how much of your monthly
          surplus it would take.
        </p>
      ) : (
        <ul className={styles.list}>
          {goalsQuery.data.items.map((goal) => {
            // Presentation geometry, NOT money math: a clamped ratio used as a
            // CSS width, exactly as the shipped GoalCard does it. No percentage
            // is ever shown as a number.
            const ratio =
              goal.target_minor > 0
                ? Math.max(0, Math.min(1, goal.saved_minor / goal.target_minor))
                : 0;
            return (
              <li key={goal.id} className={styles.row}>
                <span className={styles.name}>{goal.name}</span>
                <span className={styles.amounts}>
                  {formatMoney(goal.saved_minor, goal.currency)} of{' '}
                  {formatMoney(goal.target_minor, goal.currency)}
                </span>
                <div
                  className={styles.bar}
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={goal.target_minor}
                  aria-valuenow={goal.saved_minor}
                  // Minor units are meaningless read aloud — announce the pair.
                  aria-valuetext={`${formatMoney(goal.saved_minor, goal.currency)} of ${formatMoney(goal.target_minor, goal.currency)}`}
                  aria-label={`${goal.name} progress`}
                >
                  <div className={styles.barFill} style={{ width: `${ratio * 100}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
