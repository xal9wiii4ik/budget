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

import { Modal } from '../../components/Modal';
import { useAddContribution, type GoalRead } from '../../data/goals';
import { useLang } from '../../i18n/context';
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
    <Modal title={`Add or withdraw — ${goal.name}`} onClose={onClose} isDirty={isDirty}>
      <form className={styles.form} onSubmit={onSubmit} noValidate>
        {errors.root?.message ? (
          <p className={styles.formError} role="alert">
            {errors.root.message}
          </p>
        ) : null}

        <fieldset className={styles.field}>
          <legend className={styles.label}>Direction</legend>
          <div className={styles.directionGroup}>
            <label className={styles.directionOption}>
              <input type="radio" value="add" {...register('direction')} />
              Add
            </label>
            <label className={styles.directionOption}>
              <input type="radio" value="withdraw" {...register('direction')} />
              Withdraw
            </label>
          </div>
        </fieldset>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="contribution-amount">
            Amount ({goal.currency})
          </label>
          <input
            id="contribution-amount"
            inputMode="decimal"
            className={errors.amount ? `${styles.input} ${styles.inputError}` : styles.input}
            aria-invalid={errors.amount ? true : undefined}
            aria-describedby="contribution-amount-hint"
            {...register('amount')}
          />
          <p className={styles.hint} id="contribution-amount-hint">
            {direction === 'withdraw'
              ? 'Enter how much to take out — no minus sign needed.'
              : 'Enter how much to put aside.'}
          </p>
          {errors.amount?.message ? (
            <p className={styles.fieldError} role="alert">
              {errors.amount.message}
            </p>
          ) : null}
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="contribution-date">
            Date
          </label>
          <input
            id="contribution-date"
            type="date"
            className={
              errors.occurred_at ? `${styles.input} ${styles.inputError}` : styles.input
            }
            aria-invalid={errors.occurred_at ? true : undefined}
            {...register('occurred_at')}
          />
          {isFutureDated ? (
            <p className={styles.notice} role="status">
              This date is in the future. It counts toward the goal right away, but the
              progress chart only shows months up to this one.
            </p>
          ) : null}
          {errors.occurred_at?.message ? (
            <p className={styles.fieldError} role="alert">
              {errors.occurred_at.message}
            </p>
          ) : null}
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="contribution-note">
            Note <span className={styles.hint}>(optional)</span>
          </label>
          <textarea
            id="contribution-note"
            className={errors.note ? `${styles.textarea} ${styles.inputError}` : styles.textarea}
            maxLength={500}
            aria-invalid={errors.note ? true : undefined}
            {...register('note')}
          />
          {errors.note?.message ? (
            <p className={styles.fieldError} role="alert">
              {errors.note.message}
            </p>
          ) : null}
        </div>

        <div className={styles.actions}>
          <span className={styles.spacer} />
          <button type="submit" className={styles.submit} disabled={pending}>
            {pending ? 'Saving…' : direction === 'withdraw' ? 'Withdraw' : 'Add'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
