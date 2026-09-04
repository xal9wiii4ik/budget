import { formatMoney, toInputString } from '@budget/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';

import { Button } from '../../../components/Button';
import { Field, Input } from '../../../components/Field';
import { useUpdateGoal, type GoalRead } from '../../../data/goals';
import { useLang, useLocale, useT } from '../../../i18n/context';
import { describeGoalError } from '../../../lib/errors';
import {
  goalCostFormSchema,
  type GoalCostFormInput,
  type GoalCostFormValues,
} from './goalCostFormSchema';
import styles from './FinalCostSection.module.css';

interface FinalCostSectionProps {
  goal: GoalRead;
}

/**
 * The goal's two manual money fields, edited HERE rather than in the goal form:
 * a manual final cost only means something next to the bottom-up sum it
 * overrides, and that sum is on this screen.
 *
 * The bottom-up total stays visible whatever is typed — the override never
 * REPLACES it on screen, it sits beside it, so the discrepancy the user is
 * deciding about is always readable (task.md).
 *
 * Both fields are PATCH-only by contract (`GoalCreate` carries neither), and both
 * follow the omit / value / null discipline: an untouched field is not sent, a
 * cleared one is sent as an explicit null ("back to the sum of the items").
 */
export function FinalCostSection({ goal }: FinalCostSectionProps) {
  const t = useT();
  const lang = useLang();
  const locale = useLocale();
  const currency = goal.goal_currency;
  const updateGoal = useUpdateGoal();

  const defaultValues: GoalCostFormInput = {
    final_cost:
      goal.final_cost_override_minor === null
        ? ''
        : toInputString(goal.final_cost_override_minor, currency),
    initial_budget:
      goal.initial_budget_minor === null
        ? ''
        : toInputString(goal.initial_budget_minor, currency),
  };

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<GoalCostFormInput, unknown, GoalCostFormValues>({
    resolver: zodResolver(goalCostFormSchema(currency, t)),
    defaultValues,
  });

  const pending = isSubmitting || updateGoal.isPending;

  // A manual total only MEANS something once the goal has items to override: with
  // no plan the goal's amount is its target, and offering a second one here would
  // be a control that changes nothing. It stays visible when a stored override
  // outlives the last item — otherwise there would be no way to clear it.
  const showFinalCost = goal.has_items || goal.final_cost_override_minor !== null;

  const onSubmit = handleSubmit(async (values) => {
    const patch: Parameters<typeof updateGoal.mutateAsync>[0]['body'] = {};
    if (values.final_cost !== goal.final_cost_override_minor) {
      patch.final_cost_override_minor = values.final_cost;
    }
    if (values.initial_budget !== goal.initial_budget_minor) {
      patch.initial_budget_minor = values.initial_budget;
    }
    if (Object.keys(patch).length === 0) return;

    try {
      await updateGoal.mutateAsync({ id: goal.id, body: patch });
    } catch (error) {
      const { field, message } = describeGoalError(error, lang);
      setError(
        field === 'final_cost_override_minor'
          ? 'final_cost'
          : field === 'initial_budget_minor'
            ? 'initial_budget'
            : 'root',
        { message },
      );
    }
  });

  if (goal.archived) {
    // Read-only: an archived goal takes no writes (422 GOAL_ARCHIVED), so the
    // affordance is not offered — the numbers still are.
    return (
      <section className={styles.section}>
        <h2 className={styles.title}>{t('goalPlan.costTitle')}</h2>
        {goal.has_items || goal.final_cost_override_minor !== null ? (
          <p className={styles.readOnly}>
            {t('goalPlan.finalCostManual')}{' '}
            <strong className="tnum">
              {goal.final_cost_override_minor === null
                ? t('goalPlan.finalCostNone')
                : formatMoney(goal.final_cost_override_minor, currency, { locale })}
            </strong>
          </p>
        ) : null}
        <p className={styles.readOnly}>
          {t('goalPlan.initialBudget')}{' '}
          <strong className="tnum">
            {goal.initial_budget_minor === null
              ? t('goalPlan.finalCostNone')
              : formatMoney(goal.initial_budget_minor, currency, { locale })}
          </strong>
        </p>
      </section>
    );
  }

  return (
    <section className={styles.section}>
      <h2 className={styles.title}>{t('goalPlan.costTitle')}</h2>
      {showFinalCost ? (
        <p className={styles.lede}>
          {t('goalPlan.costLede', {
            amount: formatMoney(goal.planned_total_minor, currency, { locale }),
          })}
        </p>
      ) : null}

      <form className={styles.form} onSubmit={onSubmit} noValidate>
        {errors.root?.message ? (
          <p className={styles.formError} role="alert">
            {errors.root.message}
          </p>
        ) : null}

        {showFinalCost ? (
          <Field
            label={
              <>
                {t('goalPlan.finalCostLabel')}{' '}
                <span className={styles.hint}>{t('common.optional')}</span>
              </>
            }
            htmlFor="goal-final-cost"
            hint={t('goalPlan.finalCostHint', { currency })}
            hintId="goal-final-cost-hint"
            error={errors.final_cost?.message}
          >
            <Input
              id="goal-final-cost"
              inputMode="decimal"
              aria-invalid={errors.final_cost ? true : undefined}
              aria-describedby="goal-final-cost-hint"
              {...register('final_cost')}
            />
          </Field>
        ) : null}

        <Field
          label={
            <>
              {t('goalPlan.initialBudgetLabel')}{' '}
              <span className={styles.hint}>{t('common.optional')}</span>
            </>
          }
          htmlFor="goal-initial-budget"
          hint={t('goalPlan.initialBudgetHint', { currency })}
          hintId="goal-initial-budget-hint"
          error={errors.initial_budget?.message}
        >
          <Input
            id="goal-initial-budget"
            inputMode="decimal"
            aria-invalid={errors.initial_budget ? true : undefined}
            aria-describedby="goal-initial-budget-hint"
            {...register('initial_budget')}
          />
        </Field>

        <div className={styles.actions}>
          <Button type="submit" variant="primary" loading={pending}>
            {t(pending ? 'common.saving' : 'common.save')}
          </Button>
          {updateGoal.isSuccess ? (
            <span className={styles.status} role="status">
              {t('goalPlan.costSaved')}
            </span>
          ) : null}
        </div>
      </form>
    </section>
  );
}
