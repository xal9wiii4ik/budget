import { zodResolver } from '@hookform/resolvers/zod';
import {
  accountFormSchema,
  toSignedInputString,
  type AccountFormInput,
  type AccountFormValues,
} from '@budget/shared';
import { buildAccountPatch } from '@budget/api-client';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { CurrencySelect } from '../../components/CurrencySelect';
import { Modal } from '../../components/Modal';
import { currencyOptions } from '../../components/currencyOptions';
import { useCreateAccount, useUpdateAccount, type AccountRead } from '../../data/accounts';
import { useLang, useT } from '../../i18n/context';
import { describeAccountError } from '../../lib/errors';
import styles from './AccountFormModal.module.css';

interface AccountFormModalProps {
  /** `undefined` = create mode; an account = edit mode. */
  account?: AccountRead;
  /**
   * Which currency a NEW account's picker starts on — the profile base, or
   * `undefined` while the summary that carries it is still loading. This is a
   * convenience HIGHLIGHT on a control the user then confirms, never a decode
   * currency (nothing is decoded before they pick), so falling back to the first
   * supported code is a fine default rather than an AM-5 guess.
   */
  defaultCurrency: string | undefined;
  onClose: () => void;
}

/**
 * Create/edit an account, with archive/unarchive behind a confirmation
 * (the CategoryFormModal pattern — accounts have no DELETE at all, by design:
 * deleting one would take its transactions with it).
 *
 * The CURRENCY is chosen once, at creation, and is read-only afterwards
 * (architecture §4): every row on the account is denominated in it and the
 * balance is a plain integer sum, so changing it would silently reinterpret
 * history. The read-only arm says what to do instead.
 *
 * `starting_balance` is the only signed money input in the app — a credit card
 * legitimately starts in the minus — and the shared schema owns that sign rule.
 */
export function AccountFormModal({ account, defaultCurrency, onClose }: AccountFormModalProps) {
  const lang = useLang();
  const t = useT();
  const isEdit = account !== undefined;
  const startingCurrency = account?.currency ?? defaultCurrency ?? currencyOptions()[0];

  const createAccount = useCreateAccount();
  const updateAccount = useUpdateAccount();
  const archiveAccount = useUpdateAccount();
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [archiveError, setArchiveError] = useState<string | undefined>(undefined);

  const defaultValues: AccountFormInput = account
    ? {
        name: account.name,
        type: account.type,
        currency: account.currency,
        // AM-5: decoded with the account's OWN currency, never a base. SIGNED:
        // `toInputString` takes a magnitude and throws on a negative, and a
        // credit card's stored balance is legitimately negative — prefilling it
        // through the unsigned helper crashed the edit modal outright.
        starting_balance: toSignedInputString(
          account.starting_balance_minor,
          account.currency,
        ),
      }
    : { name: '', type: 'card', currency: startingCurrency, starting_balance: '' };

  // Output-shaped baseline for the PATCH diff.
  const initial: AccountFormValues = {
    name: account?.name ?? '',
    type: account?.type ?? 'card',
    // Diff BASELINE, not a decode fallback: the create branch never reaches the
    // patch builder at all.
    currency: startingCurrency,
    starting_balance_minor: account?.starting_balance_minor ?? 0,
  };

  const {
    control,
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<AccountFormInput, unknown, AccountFormValues>({
    resolver: zodResolver(accountFormSchema),
    defaultValues,
  });

  // The exponent the starting balance is parsed with follows this value, so the
  // hint has to name the currency the user has actually picked.
  const currency = useWatch({ control, name: 'currency' });

  const onSubmit = handleSubmit(async (values) => {
    try {
      if (isEdit && account) {
        const patch = buildAccountPatch(values, initial);
        if (Object.keys(patch).length > 0) {
          await updateAccount.mutateAsync({ id: account.id, body: patch });
        }
      } else {
        await createAccount.mutateAsync({
          name: values.name,
          type: values.type,
          currency: values.currency,
          starting_balance_minor: values.starting_balance_minor,
        });
      }
      onClose();
    } catch (error) {
      const { field, message } = describeAccountError(error, lang);
      const target =
        field === 'form'
          ? 'root'
          : field === 'starting_balance_minor'
            ? 'starting_balance'
            : field;
      setError(target, { message });
    }
  });

  const confirmArchive = async () => {
    if (!account) return;
    setArchiveError(undefined);
    try {
      await archiveAccount.mutateAsync({
        id: account.id,
        body: { archived: !account.archived },
      });
      onClose();
    } catch (error) {
      setArchiveError(describeAccountError(error, lang).message);
    }
  };

  if (confirmingArchive && account) {
    const archiving = !account.archived;
    return (
      <ConfirmDialog
        title={t(archiving ? 'accountForm.archiveTitle' : 'accountForm.unarchiveTitle')}
        message={t(
          archiving ? 'accountForm.archiveMessage' : 'accountForm.unarchiveMessage',
          { name: account.name },
        )}
        confirmLabel={t(archiving ? 'common.archive' : 'common.unarchive')}
        pendingLabel={t(archiving ? 'common.archiving' : 'common.unarchiving')}
        destructive={archiving}
        isPending={archiveAccount.isPending}
        errorMessage={archiveError}
        onConfirm={() => {
          void confirmArchive();
        }}
        onCancel={() => setConfirmingArchive(false)}
      />
    );
  }

  const pending = isSubmitting || createAccount.isPending || updateAccount.isPending;

  return (
    <Modal
      title={t(isEdit ? 'accountForm.editTitle' : 'accountForm.newTitle')}
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
          <label className={styles.label} htmlFor="account-name">
            {t('common.name')}
          </label>
          <input
            id="account-name"
            className={errors.name ? `${styles.input} ${styles.inputError}` : styles.input}
            maxLength={100}
            aria-invalid={errors.name ? true : undefined}
            {...register('name')}
          />
          {errors.name?.message ? (
            <p className={styles.fieldError} role="alert">
              {errors.name.message}
            </p>
          ) : null}
        </div>

        <fieldset className={styles.field}>
          <legend className={styles.label}>{t('common.type')}</legend>
          <div className={styles.radioGroup}>
            <label className={styles.radioOption}>
              <input type="radio" value="card" {...register('type')} />
              {t('accounts.typeCard')}
            </label>
            <label className={styles.radioOption}>
              <input type="radio" value="cash" {...register('type')} />
              {t('accounts.typeCash')}
            </label>
          </div>
        </fieldset>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="account-currency">
            {t('common.currency')}
          </label>
          {isEdit ? (
            <>
              {/* Read-only TEXT, not a disabled select: a disabled control reads
                  as "temporarily unavailable", while this is permanent (§4). */}
              <p className={styles.readOnlyValue} id="account-currency">
                {initial.currency}
              </p>
              <p className={styles.hint}>{t('accountForm.currencyImmutableHint')}</p>
            </>
          ) : (
            <>
              <CurrencySelect
                id="account-currency"
                registration={register('currency')}
                className={styles.select}
              />
              <p className={styles.hint}>{t('accountForm.currencyCreateHint')}</p>
            </>
          )}
          {errors.currency?.message ? (
            <p className={styles.fieldError} role="alert">
              {errors.currency.message}
            </p>
          ) : null}
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="account-starting-balance">
            {t('accountForm.startingBalance')}{' '}
            <span className={styles.hint}>{t('common.optional')}</span>
          </label>
          <input
            id="account-starting-balance"
            inputMode="decimal"
            className={
              errors.starting_balance ? `${styles.input} ${styles.inputError}` : styles.input
            }
            aria-invalid={errors.starting_balance ? true : undefined}
            aria-describedby="account-starting-balance-hint"
            {...register('starting_balance')}
          />
          <p className={styles.hint} id="account-starting-balance-hint">
            {t('accountForm.startingBalanceHint', { currency })}
          </p>
          {errors.starting_balance?.message ? (
            <p className={styles.fieldError} role="alert">
              {errors.starting_balance.message}
            </p>
          ) : null}
        </div>

        <div className={styles.actions}>
          {isEdit && account ? (
            <button
              type="button"
              className={styles.archive}
              onClick={() => {
                setArchiveError(undefined);
                setConfirmingArchive(true);
              }}
            >
              {t(account.archived ? 'common.unarchive' : 'common.archive')}
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
