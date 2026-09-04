import type { components } from '@budget/api-client';
import {
  categoryLimitFormSchema,
  formatMoney,
  toInputString,
  type CategoryLimitFormInput,
  type CategoryLimitFormValues,
} from '@budget/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';

import { Button } from '../../components/Button';
import { Input } from '../../components/Field';
import { Modal } from '../../components/Modal';
import { useUpsertLimit } from '../../data/limits';
import { useLang, useLocale, useT } from '../../i18n/context';
import { describeLimitError } from '../../lib/errors';
import styles from './LimitFormModal.module.css';

type CategoryRead = components['schemas']['CategoryRead'];

interface LimitFormModalProps {
  category: CategoryRead;
  /** `LimitsRead.currency` — the base the server will stamp this budget with. */
  currency: string;
  /** The stored budget, if any, with the currency it was stamped in (D15). */
  existing?: { minor: number; currency: string };
  onClose: () => void;
}

/**
 * Set / edit one category's monthly budget. `PUT /limits/{category_id}` is a full
 * upsert with a one-field body (D17), so there is no patch builder here and no
 * create/edit split beyond the copy.
 *
 * The currency is READ-ONLY text, not a picker: D15 makes the stamp a server
 * decision (always the current base), so offering a choice would promise
 * something the API cannot honour.
 *
 * Prefill is gated on the stamp matching the current base (AM-5). When they
 * differ — the "Update budget" path out of a mismatch — the old number is NOT
 * poured into a field denominated in another currency: 5 000 JPY prefilled as
 * "5000" under a RUB base would silently become ₽5 000,00. The old amount is
 * shown as text, in its own currency, and the user retypes the new one.
 */
export function LimitFormModal({
  category,
  currency,
  existing,
  onClose,
}: LimitFormModalProps) {
  const lang = useLang();
  const locale = useLocale();
  const t = useT();
  const upsertLimit = useUpsertLimit();
  const sameCurrency = existing !== undefined && existing.currency === currency;

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<CategoryLimitFormInput, unknown, CategoryLimitFormValues>({
    resolver: zodResolver(categoryLimitFormSchema(currency)),
    defaultValues: {
      amount: sameCurrency && existing ? toInputString(existing.minor, currency) : '',
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      await upsertLimit.mutateAsync({
        categoryId: category.id,
        amountMinor: values.amount,
      });
      onClose();
    } catch (error) {
      const { field, message } = describeLimitError(error, lang);
      setError(field === 'form' ? 'root' : 'amount', { message });
    }
  });

  const pending = isSubmitting || upsertLimit.isPending;

  return (
    <Modal
      title={t(existing ? 'limitForm.editTitle' : 'limitForm.setTitle', {
        name: category.name,
      })}
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

        <div className={styles.field}>
          <label className={styles.label} htmlFor="limit-amount">
            {t('limitForm.amount')}
          </label>
          <div className={styles.amountRow}>
            <Input
              id="limit-amount"
              inputMode="decimal"
              autoComplete="off"
              aria-invalid={errors.amount ? true : undefined}
              aria-describedby="limit-amount-hint"
              {...register('amount')}
            />
            <span className={styles.currency}>{currency}</span>
          </div>
          <p className={styles.hint} id="limit-amount-hint">
            {t('limitForm.baseCurrencyHint')}
          </p>
          {existing && !sameCurrency ? (
            <p className={styles.notice}>
              {t('limitForm.restamp', {
                amount: formatMoney(existing.minor, existing.currency, { locale }),
                currency,
              })}
            </p>
          ) : null}
          {errors.amount?.message ? (
            <p className={styles.fieldError} role="alert">
              {errors.amount.message}
            </p>
          ) : null}
        </div>

        <div className={styles.actions}>
          <span className={styles.spacer} />
          <Button type="submit" variant="primary" loading={pending}>
            {pending ? t('common.saving') : t('limitForm.submit')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
