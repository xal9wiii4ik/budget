import { zodResolver } from '@hookform/resolvers/zod';
import {
  goalFormSchema,
  toInputString,
  type GoalFormInput,
  type GoalFormValues,
} from '@budget/shared';
import { buildGoalPatch } from '@budget/api-client';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';

import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { CurrencySelect } from '../../components/CurrencySelect';
import { Field, Input } from '../../components/Field';
import { Modal } from '../../components/Modal';
import { useCreateGoal, useUpdateGoal, type GoalRead } from '../../data/goals';
import { useLang, useT } from '../../i18n/context';
import { describeGoalError } from '../../lib/errors';
import styles from './GoalFormModal.module.css';

interface GoalFormModalProps {
  // `undefined` = create mode; a goal = edit mode.
  goal?: GoalRead;
  // The profile base currency (AM-4 `base_currency` from the goals response) —
  // used ONLY as the default pick for a new goal, never to decode an amount.
  baseCurrency: string;
  onClose: () => void;
}

export function GoalFormModal({ goal, baseCurrency, onClose }: GoalFormModalProps) {
  const lang = useLang();
  const t = useT();
  const isEdit = goal !== undefined;

  const createGoal = useCreateGoal();
  const updateGoal = useUpdateGoal();

  // Holds the validated values while the currency-change warning is on screen
  // (edit mode only) — the D12 relabel is destructive-adjacent enough to confirm.
  const [pendingCurrencyChange, setPendingCurrencyChange] = useState<GoalFormValues | null>(
    null,
  );

  const defaultValues: GoalFormInput = goal
    ? {
        name: goal.name,
        // AM-5: the target decodes with the GOAL's own currency, never the base.
        target: toInputString(goal.target_minor, goal.currency),
        currency: goal.currency,
        deadline: goal.deadline ?? '',
        priority: String(goal.priority),
        initial_saved: '',
      }
    : {
        name: '',
        target: '',
        currency: baseCurrency,
        deadline: '',
        priority: '',
        initial_saved: '',
      };

  // Output-shaped baseline for the PATCH diff.
  const initial: GoalFormValues = {
    name: goal?.name ?? '',
    target_minor: goal?.target_minor ?? 0,
    currency: goal?.currency ?? baseCurrency,
    deadline: goal?.deadline ?? null,
    priority: goal?.priority ?? null,
    // Create-only; it has no PATCH representation (buildGoalPatch drops it).
    initial_saved_minor: null,
  };

  const {
    control,
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<GoalFormInput, unknown, GoalFormValues>({
    resolver: zodResolver(goalFormSchema),
    defaultValues,
  });

  const currency = useWatch({ control, name: 'currency' });

  const submitValues = async (values: GoalFormValues) => {
    try {
      if (isEdit && goal) {
        const patch = buildGoalPatch(values, initial);
        if (Object.keys(patch).length > 0) {
          await updateGoal.mutateAsync({ id: goal.id, body: patch });
        }
      } else {
        await createGoal.mutateAsync({
          name: values.name,
          target_minor: values.target_minor,
          currency: values.currency,
          deadline: values.deadline,
          priority: values.priority,
          initial_saved_minor: values.initial_saved_minor,
        });
      }
      onClose();
    } catch (error) {
      // The 404 list refetch is handled by the mutation's onError in data/goals.ts;
      // here we only route the message onto the right field.
      const { field, message } = describeGoalError(error, lang);
      // The two plan money fields are edited on the PLAN screen, not here, and
      // this form never sends them — a 422 naming one is a bug signal, so it
      // lands at form level rather than on an input that does not exist.
      const target =
        field === 'form' ||
        field === 'initial_budget_minor' ||
        field === 'final_cost_override_minor'
          ? 'root'
          : field === 'target_minor'
            ? 'target'
            : field;
      setError(target, { message });
    } finally {
      setPendingCurrencyChange(null);
    }
  };

  const onSubmit = handleSubmit(async (values) => {
    // D12: changing the currency RELABELS the ledger — contribution rows keep
    // their numbers and are simply read as the new currency. Nothing converts.
    if (isEdit && values.currency !== initial.currency) {
      setPendingCurrencyChange(values);
      return;
    }
    await submitValues(values);
  });

  if (pendingCurrencyChange) {
    return (
      <ConfirmDialog
        title={t('goalForm.currencyChangeTitle')}
        message={t('goalForm.currencyChangeMessage', {
          currency: pendingCurrencyChange.currency,
        })}
        confirmLabel={t('goalForm.currencyChangeTitle')}
        pendingLabel={t('common.saving')}
        isPending={updateGoal.isPending}
        onConfirm={() => void submitValues(pendingCurrencyChange)}
        onCancel={() => setPendingCurrencyChange(null)}
      />
    );
  }

  const pending = isSubmitting || createGoal.isPending || updateGoal.isPending;

  return (
    <Modal
      title={t(isEdit ? 'goalForm.editTitle' : 'goalForm.newTitle')}
      onClose={onClose}
      isDirty={isDirty}
    >
      <form className={styles.form} onSubmit={onSubmit} noValidate>
        {errors.root?.message ? (
          <p className={styles.formError} role="alert">
            {errors.root.message}
          </p>
        ) : null}

        <Field label={t('common.name')} htmlFor="goal-name" error={errors.name?.message}>
          <Input
            id="goal-name"
            aria-invalid={errors.name ? true : undefined}
            {...register('name')}
          />
        </Field>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="goal-target">
            {t('goalForm.target')}
          </label>
          <div className={styles.amountRow}>
            <Input
              id="goal-target"
              inputMode="decimal"
              aria-invalid={errors.target ? true : undefined}
              {...register('target')}
            />
            <label className={styles.srOnly} htmlFor="goal-currency">
              {t('common.currency')}
            </label>
            <CurrencySelect
              id="goal-currency"
              registration={register('currency')}
              // An existing goal in an out-of-set currency stays selectable.
              extraCurrency={goal?.currency}
            />
          </div>
          {errors.target?.message ? (
            <p className={styles.fieldError} role="alert">
              {errors.target.message}
            </p>
          ) : null}
          {errors.currency?.message ? (
            <p className={styles.fieldError} role="alert">
              {errors.currency.message}
            </p>
          ) : null}
          {isEdit && currency !== initial.currency ? (
            <p className={styles.notice} role="status">
              {t('goalForm.currencyChangeNotice', { currency })}
            </p>
          ) : null}
        </div>

        <Field
          label={
            <>
              {t('goalForm.deadline')}{' '}
              <span className={styles.hint}>{t('common.optional')}</span>
            </>
          }
          htmlFor="goal-deadline"
          hint={t('goalForm.deadlineHint')}
          hintId="goal-deadline-hint"
          error={errors.deadline?.message}
        >
          <Input
            id="goal-deadline"
            type="date"
            aria-invalid={errors.deadline ? true : undefined}
            aria-describedby="goal-deadline-hint"
            {...register('deadline')}
          />
        </Field>

        <Field
          label={
            <>
              {t('goalForm.priority')}{' '}
              <span className={styles.hint}>{t('common.optional')}</span>
            </>
          }
          htmlFor="goal-priority"
          hint={
            <>
              {t('goalForm.priorityHint')}{' '}
              {t(isEdit ? 'goalForm.priorityHintEdit' : 'goalForm.priorityHintCreate')}
            </>
          }
          hintId="goal-priority-hint"
          error={errors.priority?.message}
        >
          <Input
            id="goal-priority"
            inputMode="numeric"
            aria-invalid={errors.priority ? true : undefined}
            aria-describedby="goal-priority-hint"
            {...register('priority')}
          />
        </Field>

        {!isEdit ? (
          <Field
            label={
              <>
                {t('goalForm.initialSaved')}{' '}
                <span className={styles.hint}>{t('common.optional')}</span>
              </>
            }
            htmlFor="goal-initial"
            hint={t('goalForm.initialSavedHint', { currency })}
            hintId="goal-initial-hint"
            error={errors.initial_saved?.message}
          >
            <Input
              id="goal-initial"
              inputMode="decimal"
              aria-invalid={errors.initial_saved ? true : undefined}
              aria-describedby="goal-initial-hint"
              {...register('initial_saved')}
            />
          </Field>
        ) : null}

        <div className={styles.actions}>
          <span className={styles.spacer} />
          <Button type="submit" variant="primary" loading={pending}>
            {t(pending ? 'common.saving' : 'common.save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
