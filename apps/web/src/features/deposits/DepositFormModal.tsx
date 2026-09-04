import { zodResolver } from '@hookform/resolvers/zod';
import { todayApiDate } from '@budget/shared';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';

import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { CurrencySelect } from '../../components/CurrencySelect';
import { Field, Input, Select } from '../../components/Field';
import { Modal } from '../../components/Modal';
import { currencyOptions } from '../../components/currencyOptions';
import { useCreateDeposit, useUpdateDeposit, type DepositRead } from '../../data/deposits';
import { useLang, useT } from '../../i18n/context';
import { describeDepositError } from '../../lib/errors';
import {
  depositFormSchema,
  DEPOSIT_NAME_MAX,
  type DepositFormInput,
  type DepositFormValues,
} from './depositFormSchema';
import { buildDepositPatch } from './depositPatch';
import styles from './DepositFormModal.module.css';

interface DepositFormModalProps {
  /** `undefined` = create mode; a deposit = edit mode. */
  deposit?: DepositRead;
  /** Which currency a NEW deposit starts on (the profile base), or undefined. */
  defaultCurrency: string | undefined;
  onClose: () => void;
}

/**
 * Create/edit a deposit, with close (archive) and reopen behind a confirmation —
 * the AccountFormModal pattern, and for the same reason: a deposit has no DELETE
 * at all, because deleting one would take its ledger and its transfers with it.
 *
 * Three things this form deliberately does NOT do:
 *
 *  * it never touches the BODY after creation. `initial_balance` is the body on
 *    the opening date — a setup fact written to the hidden account's starting
 *    balance (architecture AMENDMENT §1) — and it is not rendered on edit at
 *    all: every later movement is a transfer, and an editable "amount" here
 *    would be a second source of truth about the same money;
 *  * it never touches the CURRENCY after creation: it belongs to the ledger
 *    account and is immutable there, so the edit arm shows it as read-only text
 *    with the way out (close this deposit, open another);
 *  * it never sends `archived` beside anything else. The server accepts a write
 *    on a closed deposit only as exactly `{archived: false}`
 *    (`DEPOSIT_UNARCHIVE_ONLY`), so reopening is its own one-field PATCH and the
 *    fields of a closed deposit are disabled until it is reopened.
 */
export function DepositFormModal({
  deposit,
  defaultCurrency,
  onClose,
}: DepositFormModalProps) {
  const lang = useLang();
  const t = useT();
  const isEdit = deposit !== undefined;
  const startingCurrency = deposit?.currency ?? defaultCurrency ?? currencyOptions()[0];
  // A closed deposit refuses every write but the reopening flag, so its inputs
  // are disabled rather than left to collect a DEPOSIT_ARCHIVED.
  const locked = deposit?.archived === true;

  const createDeposit = useCreateDeposit();
  const updateDeposit = useUpdateDeposit();
  const archiveDeposit = useUpdateDeposit();
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [archiveError, setArchiveError] = useState<string | undefined>(undefined);

  const defaultValues: DepositFormInput = deposit
    ? {
        name: deposit.name,
        currency: deposit.currency,
        // The SERVER's decimal string, put back verbatim: it is already the
        // shortest spelling of the stored Decimal, so an untouched field diffs
        // as unchanged and no spurious rate write is sent.
        rate: deposit.rate_percent,
        capitalization: deposit.capitalization,
        opened_on: deposit.opened_on,
        term_end: deposit.term_end ?? '',
        tax_rate: deposit.tax_rate_percent ?? '',
        // Not rendered on edit (see the doc comment); "" parses to 0 and the
        // patch builder has no key for it.
        initial_balance: '',
      }
    : {
        name: '',
        currency: startingCurrency,
        rate: '',
        capitalization: 'none',
        // The user's own calendar (todayApiDate is LOCAL): this is the date they
        // are choosing, not one the server decided. A date in the PAST is the
        // headline case and has no lower bound; there is no upper bound either.
        opened_on: todayApiDate(),
        term_end: '',
        tax_rate: '',
        initial_balance: '',
      };

  // Output-shaped baseline for the PATCH diff.
  const initial: DepositFormValues = {
    name: deposit?.name ?? '',
    // Diff BASELINE only — the builder emits no currency key, and the create
    // branch never reaches the builder at all.
    currency: startingCurrency,
    rate_percent: deposit?.rate_percent ?? '',
    capitalization: deposit?.capitalization ?? 'none',
    opened_on: deposit?.opened_on ?? '',
    term_end: deposit?.term_end ?? null,
    tax_rate_percent: deposit?.tax_rate_percent ?? null,
    initial_balance_minor: 0,
  };

  const {
    control,
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<DepositFormInput, unknown, DepositFormValues>({
    resolver: zodResolver(depositFormSchema(t)),
    defaultValues,
  });

  // The exponent the opening body is parsed with follows this value, so the hint
  // has to name the currency the user actually picked.
  const currency = useWatch({ control, name: 'currency' });

  const onSubmit = handleSubmit(async (values) => {
    try {
      if (isEdit && deposit) {
        const patch = buildDepositPatch(values, initial);
        if (Object.keys(patch).length > 0) {
          await updateDeposit.mutateAsync({ id: deposit.id, body: patch });
        }
      } else {
        await createDeposit.mutateAsync({
          name: values.name,
          currency: values.currency,
          // STRINGS on the wire (the transfer_rate precedent): a Decimal that
          // round-trips through a JS number is a rate that can print as
          // 10.949999999999999.
          rate_percent: values.rate_percent,
          capitalization: values.capitalization,
          opened_on: values.opened_on,
          term_end: values.term_end,
          tax_rate_percent: values.tax_rate_percent,
          initial_balance_minor: values.initial_balance_minor,
        });
      }
      onClose();
    } catch (error) {
      const { field, message } = describeDepositError(error, lang);
      const target =
        field === 'form'
          ? 'root'
          : field === 'rate_percent'
            ? 'rate'
            : field === 'tax_rate_percent'
              ? 'tax_rate'
              : field === 'initial_balance_minor'
                ? 'initial_balance'
                : // Two columns this form renders no control for: the manual
                  // interest anchor (its own modal) and the archive flag (its own
                  // confirmation). A code naming either belongs at form level.
                  field === 'accrued_override_minor' || field === 'archived'
                  ? 'root'
                  : field;
      setError(target, { message });
    }
  });

  const confirmArchive = async () => {
    if (!deposit) return;
    setArchiveError(undefined);
    try {
      // EXACTLY one field, both ways. Reopening carrying anything else is
      // DEPOSIT_UNARCHIVE_ONLY, so this call is what keeps that code unreachable.
      await archiveDeposit.mutateAsync({
        id: deposit.id,
        body: { archived: !deposit.archived },
      });
      onClose();
    } catch (error) {
      setArchiveError(describeDepositError(error, lang).message);
    }
  };

  if (confirmingArchive && deposit) {
    const archiving = !deposit.archived;
    return (
      <ConfirmDialog
        title={t(archiving ? 'depositForm.archiveTitle' : 'depositForm.unarchiveTitle')}
        message={t(
          archiving ? 'depositForm.archiveMessage' : 'depositForm.unarchiveMessage',
          { name: deposit.name },
        )}
        confirmLabel={t(archiving ? 'common.archive' : 'common.unarchive')}
        pendingLabel={t(archiving ? 'common.archiving' : 'common.unarchiving')}
        destructive={archiving}
        isPending={archiveDeposit.isPending}
        errorMessage={archiveError}
        onConfirm={() => {
          void confirmArchive();
        }}
        onCancel={() => setConfirmingArchive(false)}
      />
    );
  }

  const pending = isSubmitting || createDeposit.isPending || updateDeposit.isPending;

  return (
    <Modal
      title={t(isEdit ? 'depositForm.editTitle' : 'depositForm.newTitle')}
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

        {locked ? (
          <p className={styles.notice} role="status">
            {t('depositForm.archivedNotice')}
          </p>
        ) : null}

        <Field label={t('common.name')} htmlFor="deposit-name" error={errors.name?.message}>
          <Input
            id="deposit-name"
            maxLength={DEPOSIT_NAME_MAX}
            disabled={locked}
            aria-invalid={errors.name ? true : undefined}
            {...register('name')}
          />
        </Field>

        <Field
          label={t('common.currency')}
          htmlFor="deposit-currency"
          hint={t(isEdit ? 'depositForm.currencyImmutableHint' : 'depositForm.currencyCreateHint')}
          error={errors.currency?.message}
        >
          {isEdit ? (
            /* Read-only TEXT, not a disabled select: a disabled control reads as
               "temporarily unavailable", while this is permanent. */
            <p className={styles.readOnlyValue} id="deposit-currency">
              {initial.currency}
            </p>
          ) : (
            <CurrencySelect id="deposit-currency" registration={register('currency')} />
          )}
        </Field>

        <Field
          label={t('depositForm.rate')}
          htmlFor="deposit-rate"
          hint={t('depositForm.rateHint')}
          hintId="deposit-rate-hint"
          error={errors.rate?.message}
        >
          <Input
            id="deposit-rate"
            inputMode="decimal"
            disabled={locked}
            aria-invalid={errors.rate ? true : undefined}
            aria-describedby="deposit-rate-hint"
            {...register('rate')}
          />
        </Field>

        <Field
          label={t('depositForm.capitalization')}
          htmlFor="deposit-capitalization"
          error={errors.capitalization?.message}
        >
          {/* ONE enum, not a checkbox plus a period (architecture): "no
              capitalization, but quarterly" is then unrepresentable. */}
          <Select id="deposit-capitalization" disabled={locked} {...register('capitalization')}>
            <option value="none">{t('depositForm.capNone')}</option>
            <option value="monthly">{t('depositForm.capMonthly')}</option>
            <option value="quarterly">{t('depositForm.capQuarterly')}</option>
            <option value="at_maturity">{t('depositForm.capAtMaturity')}</option>
          </Select>
        </Field>

        <Field
          label={t('depositForm.openedOn')}
          htmlFor="deposit-opened-on"
          hint={t('depositForm.openedOnHint')}
          hintId="deposit-opened-on-hint"
          error={errors.opened_on?.message}
        >
          <Input
            id="deposit-opened-on"
            type="date"
            disabled={locked}
            aria-invalid={errors.opened_on ? true : undefined}
            aria-describedby="deposit-opened-on-hint"
            {...register('opened_on')}
          />
        </Field>

        <Field
          label={
            <>
              {t('depositForm.termEnd')}{' '}
              <span className={styles.hint}>{t('common.optional')}</span>
            </>
          }
          htmlFor="deposit-term-end"
          hint={t('depositForm.termEndHint')}
          hintId="deposit-term-end-hint"
          error={errors.term_end?.message}
        >
          <Input
            id="deposit-term-end"
            type="date"
            disabled={locked}
            aria-invalid={errors.term_end ? true : undefined}
            aria-describedby="deposit-term-end-hint"
            {...register('term_end')}
          />
        </Field>

        <Field
          label={
            <>
              {t('depositForm.taxRate')} <span className={styles.hint}>{t('common.optional')}</span>
            </>
          }
          htmlFor="deposit-tax-rate"
          hint={t('depositForm.taxRateHint')}
          hintId="deposit-tax-rate-hint"
          error={errors.tax_rate?.message}
        >
          <Input
            id="deposit-tax-rate"
            inputMode="decimal"
            disabled={locked}
            aria-invalid={errors.tax_rate ? true : undefined}
            aria-describedby="deposit-tax-rate-hint"
            {...register('tax_rate')}
          />
        </Field>

        {/* CREATE ONLY. On edit this input is absent, not disabled: the body is
            moved by transfers from here on, and showing a greyed-out amount would
            suggest there is a way to edit it. */}
        {isEdit ? null : (
          <Field
            label={
              <>
                {t('depositForm.initialBalance')}{' '}
                <span className={styles.hint}>{t('common.optional')}</span>
              </>
            }
            htmlFor="deposit-initial-balance"
            hint={t('depositForm.initialBalanceHint', { currency })}
            hintId="deposit-initial-balance-hint"
            error={errors.initial_balance?.message}
          >
            <Input
              id="deposit-initial-balance"
              inputMode="decimal"
              aria-invalid={errors.initial_balance ? true : undefined}
              aria-describedby="deposit-initial-balance-hint"
              {...register('initial_balance')}
            />
          </Field>
        )}

        <div className={styles.actions}>
          {isEdit && deposit ? (
            <Button
              onClick={() => {
                setArchiveError(undefined);
                setConfirmingArchive(true);
              }}
            >
              {t(deposit.archived ? 'common.unarchive' : 'common.archive')}
            </Button>
          ) : null}
          <span className={styles.spacer} />
          <Button type="submit" variant="primary" loading={pending} disabled={locked}>
            {t(pending ? 'common.saving' : 'common.save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
