import { zodResolver } from '@hookform/resolvers/zod';
import {
  contributionFormSchema,
  signedAmountMinor,
  todayApiDate,
  type ContributionFormInput,
  type ContributionFormValues,
} from '@budget/shared';
import { emptyToNull } from '@budget/api-client';
import { useForm, useWatch } from 'react-hook-form';

import { Button } from '../../components/Button';
import { Field, Input, Textarea } from '../../components/Field';
import { Modal } from '../../components/Modal';
import { useAddContribution, type GoalRead } from '../../data/goals';
import { useLang, useT } from '../../i18n/context';
import { describeContributionError } from '../../lib/errors';
import styles from './ContributionModal.module.css';

interface ContributionModalProps {
  goal: GoalRead;
  onClose: () => void;
}

/**
 * Add to / withdraw from a goal. The form collects a MAGNITUDE plus a direction
 * and `signedAmountMinor` applies the ledger sign once, at this single call site
 * (the API row is signed — a withdrawal is a negative amount, D10).
 *
 * The "you can't withdraw more than you saved" rule is NOT re-implemented here as
 * a client-side gate (C8): the server owns the SUM >= 0 invariant across rows and
 * a stale local `saved_minor` would either block a legal withdrawal or wave an
 * illegal one through. Its 422 lands on the amount field instead.
 */
export function ContributionModal({ goal, onClose }: ContributionModalProps) {
  const lang = useLang();
  const t = useT();
  const addContribution = useAddContribution(goal.id);

  const {
    control,
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<ContributionFormInput, unknown, ContributionFormValues>({
    resolver: zodResolver(contributionFormSchema(goal.currency)),
    defaultValues: {
      amount: '',
      direction: 'add',
      occurred_at: todayApiDate(),
      note: '',
    },
  });

  const occurredAt = useWatch({ control, name: 'occurred_at' });
  const direction = useWatch({ control, name: 'direction' });
  // Both strings are "YYYY-MM-DD", so a lexicographic compare IS a date compare.
  // A future date is allowed on purpose (PM decision): it counts toward the saved
  // total immediately, while the progress chart only covers months up to now — so
  // we say that instead of silently rejecting or silently disagreeing.
  const isFutureDated = occurredAt > todayApiDate();

  const onSubmit = handleSubmit(async (values) => {
    try {
      await addContribution.mutateAsync({
        amount_minor: signedAmountMinor(values.direction, values.amount),
        occurred_at: values.occurred_at,
        note: emptyToNull(values.note),
      });
      onClose();
    } catch (error) {
      const { field, message } = describeContributionError(error, lang);
      const target =
        field === 'form' ? 'root' : field === 'amount_minor' ? 'amount' : field;
      setError(target, { message });
    }
  });

  const pending = isSubmitting || addContribution.isPending;

  return (
    <Modal
      title={t('contribution.title', { name: goal.name })}
      onClose={onClose}
      isDirty={isDirty}
    >
      <form className={styles.form} onSubmit={onSubmit} noValidate>
        {errors.root?.message ? (
          <p className={styles.formError} role="alert">
            {errors.root.message}
          </p>
        ) : null}

        <fieldset className={styles.field}>
          <legend className={styles.label}>{t('contribution.direction')}</legend>
          <div className={styles.directionGroup}>
            <label className={styles.directionOption}>
              <input type="radio" value="add" {...register('direction')} />
              {t('contribution.add')}
            </label>
            <label className={styles.directionOption}>
              <input type="radio" value="withdraw" {...register('direction')} />
              {t('contribution.withdraw')}
            </label>
          </div>
        </fieldset>

        <Field
          label={t('contribution.amount', { currency: goal.currency })}
          htmlFor="contribution-amount"
          hint={t(
            direction === 'withdraw' ? 'contribution.hintWithdraw' : 'contribution.hintAdd',
          )}
          hintId="contribution-amount-hint"
          error={errors.amount?.message}
        >
          <Input
            id="contribution-amount"
            inputMode="decimal"
            aria-invalid={errors.amount ? true : undefined}
            aria-describedby="contribution-amount-hint"
            {...register('amount')}
          />
        </Field>

        {/* The future-date notice sits between the control and the error, which
            is a slot the shared <Field> does not have — so it travels with the
            control instead, keeping the label → input → notice → error order. */}
        <Field
          label={t('common.date')}
          htmlFor="contribution-date"
          error={errors.occurred_at?.message}
        >
          <Input
            id="contribution-date"
            type="date"
            aria-invalid={errors.occurred_at ? true : undefined}
            {...register('occurred_at')}
          />
          {isFutureDated ? (
            <p className={styles.notice} role="status">
              {t('contribution.futureNotice')}
            </p>
          ) : null}
        </Field>

        <Field
          label={
            <>
              {t('common.note')} <span className={styles.hint}>{t('common.optional')}</span>
            </>
          }
          htmlFor="contribution-note"
          error={errors.note?.message}
        >
          <Textarea
            id="contribution-note"
            maxLength={500}
            aria-invalid={errors.note ? true : undefined}
            {...register('note')}
          />
        </Field>

        <div className={styles.actions}>
          <span className={styles.spacer} />
          <Button type="submit" variant="primary" loading={pending}>
            {pending
              ? t('common.saving')
              : t(direction === 'withdraw' ? 'contribution.withdraw' : 'contribution.add')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
