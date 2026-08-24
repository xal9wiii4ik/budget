import { formatMoney } from '@budget/shared';

import type { GoalRead } from '../../../data/goals';
import { useLocale, useT } from '../../../i18n/context';
import styles from './PlanSummary.module.css';

interface PlanSummaryProps {
  goal: GoalRead;
}

/**
 * What this goal costs and where it stands — every number a SERVER field.
 *
 * Progress is THREE separate figures (task.md): paid (money that has left),
 * saved (money that is lying there) and what is still to be found. They are never
 * added together — one combined number would suggest money that does not exist —
 * and `remaining_to_find_minor` is the server's subtraction, not the client's.
 *
 * The cost block states the goal's MODE honestly:
 *   no items          — the manual target, exactly as before the plan existed;
 *   items, no override — the total is assembled BOTTOM-UP and will keep growing
 *                        as items are added (task.md demands this be visible;
 *                        without it a goal looks like it is getting pricier by
 *                        itself);
 *   items + override   — BOTH numbers side by side. Neither replaces the other:
 *                        the manual figure is what the goal is planned at, the
 *                        bottom-up sum is what the items add up to.
 *
 * Amounts that could not be converted into the goal's currency are their own
 * COUNTER lines (the `tx_totals` rule) — never hidden, never folded in.
 */
export function PlanSummary({ goal }: PlanSummaryProps) {
  const t = useT();
  const locale = useLocale();
  const currency = goal.goal_currency;

  return (
    <section className={styles.summary} aria-label={t('goalPlan.summaryAria')}>
      <div className={styles.cost}>
        {goal.has_items ? (
          goal.final_cost_override_minor !== null ? (
            <>
              <p className={styles.costLine}>
                <span className={styles.costLabel}>{t('goalPlan.finalCostManual')}</span>
                <strong className={styles.costValue}>
                  {formatMoney(goal.final_cost_override_minor, currency, { locale })}
                </strong>
              </p>
              <p className={styles.costLine}>
                <span className={styles.costLabel}>{t('goalPlan.plannedTotal')}</span>
                <strong className={styles.costValue}>
                  {formatMoney(goal.planned_total_minor, currency, { locale })}
                </strong>
              </p>
            </>
          ) : (
            <>
              <p className={styles.costLine}>
                <span className={styles.costLabel}>{t('goalPlan.finalCostBottomUp')}</span>
                <strong className={styles.costValue}>
                  {formatMoney(goal.effective_target_minor, currency, { locale })}
                </strong>
              </p>
              <p className={styles.growing} role="status">
                {t('goalPlan.planIncomplete')}
              </p>
            </>
          )
        ) : (
          <p className={styles.costLine}>
            <span className={styles.costLabel}>{t('goalPlan.manualTarget')}</span>
            <strong className={styles.costValue}>
              {/* AM-5: the manual target is denominated in the GOAL's currency. */}
              {formatMoney(goal.target_minor, goal.currency, { locale })}
            </strong>
          </p>
        )}

        {goal.initial_budget_minor !== null ? (
          <p className={styles.costLine}>
            <span className={styles.costLabel}>{t('goalPlan.initialBudget')}</span>
            <strong className={styles.costValue}>
              {formatMoney(goal.initial_budget_minor, currency, { locale })}
            </strong>
          </p>
        ) : null}
      </div>

      <dl className={styles.figures}>
        <div className={styles.figure}>
          <dt className={styles.figureLabel}>{t('goalPlan.paid')}</dt>
          <dd className={styles.figureValue}>
            {formatMoney(goal.paid_minor, currency, { locale })}
          </dd>
        </div>
        <div className={styles.figure}>
          <dt className={styles.figureLabel}>{t('goalPlan.saved')}</dt>
          <dd className={styles.figureValue}>
            {formatMoney(goal.saved_minor, currency, { locale })}
          </dd>
        </div>
        <div className={styles.figure}>
          <dt className={styles.figureLabel}>{t('goalPlan.remaining')}</dt>
          <dd className={styles.figureValue}>
            {/* Can be negative, and is shown as such: the server decided it. */}
            {formatMoney(goal.remaining_to_find_minor, currency, { locale })}
          </dd>
        </div>
      </dl>

      {goal.planned_unconverted_count > 0 ? (
        <p className={styles.counter} role="status">
          {t('goalPlan.plannedUnconverted', {
            count: goal.planned_unconverted_count,
            currency,
          })}
        </p>
      ) : null}
      {goal.paid_unconverted_count > 0 ? (
        <p className={styles.counter} role="status">
          {t('goalPlan.paidUnconverted', { count: goal.paid_unconverted_count, currency })}
        </p>
      ) : null}
    </section>
  );
}
