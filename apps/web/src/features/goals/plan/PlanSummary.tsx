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
 * In BOTH item modes the amount the user set BEFORE the plan existed stays on
 * screen as a read-only reference line — the transition dialog promises exactly
 * that, and a promise the screen then drops is a lie (qa F-3).
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
                <strong className={`${styles.costValue} tnum`}>
                  {formatMoney(goal.final_cost_override_minor, currency, { locale })}
                </strong>
              </p>
              <p className={styles.costLine}>
                <span className={styles.costLabel}>{t('goalPlan.plannedTotal')}</span>
                <strong className={`${styles.costValue} tnum`}>
                  {formatMoney(goal.planned_total_minor, currency, { locale })}
                </strong>
              </p>
            </>
          ) : (
            <>
              <p className={styles.costLine}>
                <span className={styles.costLabel}>{t('goalPlan.finalCostBottomUp')}</span>
                <strong className={`${styles.costValue} tnum`}>
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
            <strong className={`${styles.costValue} tnum`}>
              {/* AM-5: the manual target is denominated in the GOAL's currency. */}
              {formatMoney(goal.target_minor, goal.currency, { locale })}
            </strong>
          </p>
        )}

        {/* The amount the user set BEFORE the plan existed, kept visible for the
            whole life of the plan (qa F-3): the mode-transition dialog promises
            "the amount you set stays as a reference", and until this line
            existed the screen dropped it the moment the first item appeared.
            READ-ONLY and deliberately inert — nothing here compares it with the
            plan's total or subtracts one from the other; it is one server field
            (`target_minor`, in the goal's own currency, as in the no-items arm
            above), shown. */}
        {goal.has_items ? (
          <p className={styles.costLine}>
            <span className={styles.costLabel}>{t('goalPlan.targetBeforePlan')}</span>
            <span className={`${styles.reference} tnum`}>
              {formatMoney(goal.target_minor, goal.currency, { locale })}
            </span>
          </p>
        ) : null}

        {goal.initial_budget_minor !== null ? (
          <p className={styles.costLine}>
            <span className={styles.costLabel}>{t('goalPlan.initialBudget')}</span>
            <strong className={`${styles.costValue} tnum`}>
              {formatMoney(goal.initial_budget_minor, currency, { locale })}
            </strong>
          </p>
        ) : null}
      </div>

      <dl className={styles.figures}>
        <div className={styles.figure}>
          <dt className={styles.figureLabel}>{t('goalPlan.paid')}</dt>
          <dd className={`${styles.figureValue} tnum`}>
            {formatMoney(goal.paid_minor, currency, { locale })}
          </dd>
        </div>
        <div className={styles.figure}>
          <dt className={styles.figureLabel}>{t('goalPlan.saved')}</dt>
          <dd className={`${styles.figureValue} tnum`}>
            {formatMoney(goal.saved_minor, currency, { locale })}
          </dd>
        </div>
        <div className={styles.figure}>
          <dt className={styles.figureLabel}>{t('goalPlan.remaining')}</dt>
          <dd className={`${styles.figureValue} tnum`}>
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
