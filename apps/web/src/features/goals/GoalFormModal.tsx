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

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { CurrencySelect } from '../../components/CurrencySelect';
import { Modal } from '../../components/Modal';
import { useCreateGoal, useUpdateGoal, type GoalRead } from '../../data/goals';
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
      const { field, message } = describeGoalError(error);
      const target =
        field === 'form' ? 'root' : field === 'target_minor' ? 'target' : field;
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
        title="Change currency"
        message={`Changing the currency relabels every saved amount in ${pendingCurrencyChange.currency}. Nothing is recalculated or converted.`}
        confirmLabel="Change currency"
        pendingLabel="Saving…"
        isPending={updateGoal.isPending}
        onConfirm={() => void submitValues(pendingCurrencyChange)}
        onCancel={() => setPendingCurrencyChange(null)}
      />
    );
  }

  const pending = isSubmitting || createGoal.isPending || updateGoal.isPending;

  return (
    <Modal title={isEdit ? 'Edit goal' : 'New goal'} onClose={onClose} isDirty={isDirty}>
      <form className={styles.form} onSubmit={onSubmit} noValidate>
        {errors.root?.message ? (
          <p className={styles.formError} role="alert">
            {errors.root.message}
          </p>
        ) : null}

        <div className={styles.field}>
          <label className={styles.label} htmlFor="goal-name">
            Name
          </label>
          <input
            id="goal-name"
            className={errors.name ? `${styles.input} ${styles.inputError}` : styles.input}
            aria-invalid={errors.name ? true : undefined}
            {...register('name')}
          />
          {errors.name?.message ? (
            <p className={styles.fieldError} role="alert">
              {errors.name.message}
            </p>
          ) : null}
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="goal-target">
            Target amount
          </label>
          <div className={styles.amountRow}>
            <input
              id="goal-target"
              inputMode="decimal"
              className={errors.target ? `${styles.input} ${styles.inputError}` : styles.input}
              aria-invalid={errors.target ? true : undefined}
              {...register('target')}
            />
            <label className={styles.srOnly} htmlFor="goal-currency">
              Currency
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
              Saved amounts will simply be relabelled in {currency} — nothing is converted.
            </p>
          ) : null}
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="goal-deadline">
            Deadline <span className={styles.hint}>(optional)</span>
          </label>
          <input
            id="goal-deadline"
            type="date"
            className={errors.deadline ? `${styles.input} ${styles.inputError}` : styles.input}
            aria-invalid={errors.deadline ? true : undefined}
            aria-describedby="goal-deadline-hint"
            {...register('deadline')}
          />
          <p className={styles.hint} id="goal-deadline-hint">
            Without a deadline we track what you save but never say you&apos;re behind.
          </p>
          {errors.deadline?.message ? (
            <p className={styles.fieldError} role="alert">
              {errors.deadline.message}
            </p>
          ) : null}
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="goal-priority">
            Priority <span className={styles.hint}>(optional)</span>
          </label>
          <input
            id="goal-priority"
            inputMode="numeric"
            className={errors.priority ? `${styles.input} ${styles.inputError}` : styles.input}
            aria-invalid={errors.priority ? true : undefined}
            aria-describedby="goal-priority-hint"
            {...register('priority')}
          />
          <p className={styles.hint} id="goal-priority-hint">
            Lower runs first: your free balance is shared out top-priority first.{' '}
            {isEdit ? 'Leave blank to keep the current one.' : 'Leave blank to add it last.'}
          </p>
          {errors.priority?.message ? (
            <p className={styles.fieldError} role="alert">
              {errors.priority.message}
            </p>
          ) : null}
        </div>

        {!isEdit ? (
          <div className={styles.field}>
            <label className={styles.label} htmlFor="goal-initial">
              Already saved <span className={styles.hint}>(optional)</span>
            </label>
            <input
              id="goal-initial"
              inputMode="decimal"
              className={
                errors.initial_saved ? `${styles.input} ${styles.inputError}` : styles.input
              }
              aria-invalid={errors.initial_saved ? true : undefined}
              aria-describedby="goal-initial-hint"
              {...register('initial_saved')}
            />
            <p className={styles.hint} id="goal-initial-hint">
              Recorded as this goal&apos;s first contribution, in {currency}.
            </p>
            {errors.initial_saved?.message ? (
              <p className={styles.fieldError} role="alert">
                {errors.initial_saved.message}
              </p>
            ) : null}
          </div>
        ) : null}

        <div className={styles.actions}>
          <span className={styles.spacer} />
          <button type="submit" className={styles.submit} disabled={pending}>
            {pending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
