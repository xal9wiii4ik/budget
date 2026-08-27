import { zodResolver } from '@hookform/resolvers/zod';
import {
  formatApiDate,
  formatMoney,
  parseMoney,
  toInputString,
  type MoneyParseError,
} from '@budget/shared';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Modal } from '../../components/Modal';
import { useUpdateDeposit, type DepositRead } from '../../data/deposits';
import { useLang, useLocale, useT } from '../../i18n/context';
import type { Translate } from '../../i18n/t';
import { describeDepositError } from '../../lib/errors';
import styles from './DepositFormModal.module.css';

interface AccruedEditModalProps {
  deposit: DepositRead;
  onClose: () => void;
}

const MESSAGE_KEY = {
  empty: 'depositForm.error.amountMalformed',
  malformed: 'depositForm.error.amountMalformed',
  negative: 'depositForm.error.amountNegative',
  'too-many-decimals': 'depositForm.error.amountDecimals',
  overflow: 'depositForm.error.amountOverflow',
} as const satisfies Record<MoneyParseError, string>;

/** One money field, at the deposit's own currency (AM-5: never a base). */
function accruedFormSchema(currency: string, t: Translate) {
  return z.object({
    accrued: z.string().transform((raw, ctx): number => {
      const result = parseMoney(raw, currency);
      if (!result.ok) {
        ctx.addIssue({
          code: 'custom',
          params: { reason: result.error },
          message: t(MESSAGE_KEY[result.error], { currency }),
        });
        return z.NEVER;
      }
      return result.minor;
    }),
  });
}

type AccruedFormInput = z.input<ReturnType<typeof accruedFormSchema>>;
type AccruedFormValues = z.output<ReturnType<typeof accruedFormSchema>>;

/**
 * "Interest today" — the figure the server computed for TODAY, and the one place
 * the user may overrule it (task.md §4: a manual value beats the calculation,
 * as everywhere in this project).
 *
 * There is no "recalculate" REQUEST behind this dialog: `GET /deposits` already
 * carries `accrued_minor` as of today (architecture), so the button shows what
 * is in hand and this form only ever WRITES. Nothing is computed here — the
 * gross figure, the after-tax figure and the date the anchor was stamped on are
 * all server fields.
 *
 * The copy is load-bearing. The anchor is NOT a one-off correction: the forecast
 * keeps running FROM the number and the date, so tomorrow it will have grown
 * again. Saying so is what stops the user from re-entering the bank's figure
 * every morning — and "Reset to the calculated figure" (an explicit `null`,
 * behind a confirmation) is the way back.
 */
export function AccruedEditModal({ deposit, onClose }: AccruedEditModalProps) {
  const lang = useLang();
  const locale = useLocale();
  const t = useT();
  const updateDeposit = useUpdateDeposit();
  const resetDeposit = useUpdateDeposit();
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetError, setResetError] = useState<string | undefined>(undefined);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<AccruedFormInput, unknown, AccruedFormValues>({
    resolver: zodResolver(accruedFormSchema(deposit.currency, t)),
    defaultValues: {
      // Today's figure, decoded at the deposit's OWN currency. It already
      // reflects a previous anchor (the forecast continues from it), so the
      // field starts on what the row shows rather than on a stale correction.
      accrued: toInputString(deposit.accrued_minor, deposit.currency),
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      // ONE field. The `as_of` half of the anchor is stamped by the SERVER —
      // a client-supplied date could anchor the forecast in a day that never
      // happened.
      await updateDeposit.mutateAsync({
        id: deposit.id,
        body: { accrued_override_minor: values.accrued },
      });
      onClose();
    } catch (error) {
      const { field, message } = describeDepositError(error, lang);
      setError(field === 'accrued_override_minor' ? 'accrued' : 'root', { message });
    }
  });

  const confirmReset = async () => {
    setResetError(undefined);
    try {
      // An explicit null, never an omitted key: it CLEARS the stored pair and
      // the figure goes back to being computed from the deposit's own timeline.
      await resetDeposit.mutateAsync({
        id: deposit.id,
        body: { accrued_override_minor: null },
      });
      onClose();
    } catch (error) {
      setResetError(describeDepositError(error, lang).message);
    }
  };

  if (confirmingReset) {
    return (
      <ConfirmDialog
        title={t('depositAccrued.resetTitle')}
        message={t('depositAccrued.resetMessage')}
        confirmLabel={t('depositAccrued.reset')}
        pendingLabel={t('depositAccrued.resetting')}
        destructive
        isPending={resetDeposit.isPending}
        errorMessage={resetError}
        onConfirm={() => {
          void confirmReset();
        }}
        onCancel={() => setConfirmingReset(false)}
      />
    );
  }

  const pending = isSubmitting || updateDeposit.isPending;

  return (
    <Modal
      title={t('depositAccrued.title')}
      onClose={onClose}
      closeDisabled={pending}
      isDirty={isDirty}
    >
      <form className={styles.form} onSubmit={onSubmit} noValidate>
        {errors.root?.message ? (
          <p className={styles.formError} role="alert">
            {errors.root.message}
          </p>
        ) : null}

        <p className={styles.hint}>
          {t('depositAccrued.computed')}{' '}
          <strong>{formatMoney(deposit.accrued_minor, deposit.currency, { locale })}</strong>
          {/* `!== null`, not truthiness: 0 after tax is a real figure. */}
          {deposit.accrued_after_tax_minor !== null ? (
            <>
              {' · '}
              {t('depositAccrued.afterTax', {
                amount: formatMoney(deposit.accrued_after_tax_minor, deposit.currency, {
                  locale,
                }),
              })}
            </>
          ) : null}
        </p>

        {deposit.accrued_override_as_of !== null ? (
          <p className={styles.hint}>
            {t('depositAccrued.overriddenSince', {
              date: formatApiDate(deposit.accrued_override_as_of, { locale }),
            })}
          </p>
        ) : null}

        <div className={styles.field}>
          <label className={styles.label} htmlFor="deposit-accrued">
            {t('depositAccrued.field', { currency: deposit.currency })}
          </label>
          <input
            id="deposit-accrued"
            inputMode="decimal"
            className={errors.accrued ? `${styles.input} ${styles.inputError}` : styles.input}
            aria-invalid={errors.accrued ? true : undefined}
            aria-describedby="deposit-accrued-hint"
            {...register('accrued')}
          />
          <p className={styles.hint} id="deposit-accrued-hint">
            {t('depositAccrued.hint')}
          </p>
          {errors.accrued?.message ? (
            <p className={styles.fieldError} role="alert">
              {errors.accrued.message}
            </p>
          ) : null}
        </div>

        <div className={styles.actions}>
          {/* Only when there IS a stored anchor: offering to reset a figure that
              is already the calculation would be an action with no effect. */}
          {deposit.accrued_override_minor !== null ? (
            <button
              type="button"
              className={styles.archive}
              onClick={() => {
                setResetError(undefined);
                setConfirmingReset(true);
              }}
            >
              {t('depositAccrued.reset')}
            </button>
          ) : null}
          <span className={styles.spacer} />
          <button type="submit" className={styles.submit} disabled={pending}>
            {t(pending ? 'common.saving' : 'common.save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
