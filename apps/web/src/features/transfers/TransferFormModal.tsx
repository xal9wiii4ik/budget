import { zodResolver } from '@hookform/resolvers/zod';
import {
  toInputString,
  todayApiDate,
  transferFormSchema,
  type TransferFormInput,
  type TransferFormValues,
} from '@budget/shared';
import { buildTransferPatch, emptyToNull } from '@budget/api-client';
import type { components } from '@budget/api-client';
import { useMemo, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Modal } from '../../components/Modal';
import { useAccounts } from '../../data/accounts';
import {
  useCreateTransaction,
  useDeleteTransaction,
  useUpdateTransaction,
} from '../../data/transactions';
import { useLang } from '../../i18n/context';
import { describeTransactionError } from '../../lib/errors';
import { queryPhase } from '../../lib/queryPhase';
import { AccountField } from '../accounts/AccountField';
import {
  accountCurrencyLookup,
  accountFieldBlocked,
  accountIndex,
} from '../accounts/accountOptions';
import {
  pickDefaultAccount,
  readLastAccountId,
  rememberLastAccountId,
} from '../accounts/lastAccount';
import styles from './TransferFormModal.module.css';

type TransactionRead = components['schemas']['TransactionRead'];

interface TransferFormModalProps {
  /** `undefined` = create mode; a `kind === 'transfer'` row = edit mode. */
  transfer?: TransactionRead;
  onClose: () => void;
}

/**
 * Money moved between two of the user's own accounts — ONE operation with two
 * sides (addendum A1): two accounts, two amounts, one row, one delete.
 *
 * It is a separate form from `TransactionFormModal` rather than a third `kind`
 * branch: a transfer has no category, no merchant, no receipt and no
 * base-currency snapshot (architecture §5), while it has a second account and a
 * second amount that nothing else has. Keeping the kind radios at
 * expense/income also makes the server's `KIND_CHANGE_UNSUPPORTED` unreachable
 * from this UI.
 *
 * The two amounts are entered INDEPENDENTLY, each in its own account's currency:
 * that is the whole point — the user's real bank rate, not a market one. The
 * client never divides one by the other; the resulting rate is a SERVER field
 * (`transfer_rate`, addendum A2) and is only ever displayed verbatim.
 */
export function TransferFormModal({ transfer, onClose }: TransferFormModalProps) {
  const lang = useLang();
  const isEdit = transfer !== undefined;

  // Server state via Query (the same 60s-cached archived-inclusive entry every
  // other form reads); its phase is what the two pickers render honestly.
  const accountsQuery = useAccounts();
  const accounts = useMemo(() => accountsQuery.data ?? [], [accountsQuery.data]);
  const accountsPhase = queryPhase(accountsQuery);
  const retryAccounts = () => {
    void accountsQuery.refetch();
  };

  const createTransaction = useCreateTransaction();
  const updateTransaction = useUpdateTransaction();
  const deleteTransaction = useDeleteTransaction();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined);

  const byId = useMemo(() => accountIndex(accounts), [accounts]);
  // Bound at render, not at submit: the exponent each amount parses with comes
  // from the account it belongs to, and an unknown id resolves to a field error
  // rather than a guessed exponent (AM-5).
  const currencyOf = useMemo(() => accountCurrencyLookup(accounts), [accounts]);

  const defaultValues: TransferFormInput = transfer
    ? {
        account_id: transfer.account_id,
        counter_account_id: transfer.counter_account_id ?? '',
        // AM-5: each leg decodes with the currency THAT LEG is denominated in —
        // `currency` for the source, `counter_currency` for the target (A5). No
        // `?? tx.currency` fallback: a null counter currency means the row is not
        // a transfer, and the page never opens this form for one.
        amount: toInputString(transfer.amount_minor, transfer.currency),
        counter_amount:
          transfer.counter_amount_minor !== null && transfer.counter_currency !== null
            ? toInputString(transfer.counter_amount_minor, transfer.counter_currency)
            : '',
        occurred_at: transfer.occurred_at,
        note: transfer.note ?? '',
      }
    : {
        account_id: pickDefaultAccount(accounts, readLastAccountId()),
        counter_account_id: '',
        amount: '',
        counter_amount: '',
        occurred_at: todayApiDate(),
        note: '',
      };

  // Output-shaped baseline for the PATCH diff.
  const initial: TransferFormValues = {
    account_id: transfer?.account_id ?? '',
    currency: transfer?.currency ?? '',
    amount_minor: transfer?.amount_minor ?? 0,
    counter_account_id: transfer?.counter_account_id ?? '',
    counter_currency: transfer?.counter_currency ?? '',
    counter_amount_minor: transfer?.counter_amount_minor ?? 0,
    occurred_at: transfer?.occurred_at ?? '',
    note: transfer?.note ?? '',
  };

  const {
    control,
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<TransferFormInput, unknown, TransferFormValues>({
    resolver: zodResolver(transferFormSchema(currencyOf)),
    defaultValues,
  });

  const sourceId = useWatch({ control, name: 'account_id' });
  const targetId = useWatch({ control, name: 'counter_account_id' });
  // Each amount input is labelled with the currency it will be read in, so the
  // user always knows which side of the rate they are typing.
  const sourceCurrency = byId.get(sourceId)?.currency;
  const targetCurrency = byId.get(targetId)?.currency;

  const sourceReg = register('account_id');
  const targetReg = register('counter_account_id');

  const onSubmit = handleSubmit(async (values) => {
    try {
      if (isEdit && transfer) {
        const patch = buildTransferPatch(values, initial);
        if (Object.keys(patch).length > 0) {
          await updateTransaction.mutateAsync({
            id: transfer.id,
            body: patch,
            previousOccurredAt: transfer.occurred_at,
          });
        }
      } else {
        await createTransaction.mutateAsync({
          kind: 'transfer',
          account_id: values.account_id,
          amount_minor: values.amount_minor,
          counter_account_id: values.counter_account_id,
          counter_amount_minor: values.counter_amount_minor,
          occurred_at: values.occurred_at,
          note: emptyToNull(values.note),
          // No `currency` / `counter_currency`: both are STAMPED from the two
          // accounts server-side (§4/A5). No `category_id`: a transfer has none
          // (the CHECK forbids it) — it is not spending, it is moving.
        });
        rememberLastAccountId(values.account_id);
      }
      onClose();
    } catch (error) {
      const { field, message } = describeTransactionError(error, lang);
      const target =
        field === 'form'
          ? 'root'
          : field === 'amount_minor'
            ? 'amount'
            : field === 'counter_amount_minor'
              ? 'counter_amount'
              : field === 'category_id' || field === 'merchant'
                ? 'root'
                : field;
      setError(target, { message });
    }
  });

  const confirmDelete = async () => {
    if (!transfer) return;
    setDeleteError(undefined);
    try {
      await deleteTransaction.mutateAsync({
        id: transfer.id,
        occurredAt: transfer.occurred_at,
      });
      onClose();
    } catch (error) {
      setDeleteError(describeTransactionError(error, lang).message);
    }
  };

  if (confirmingDelete && transfer) {
    return (
      <ConfirmDialog
        title="Delete transfer"
        // A1: one operation, one delete — both sides go, and both balances move
        // back. Saying so is what stops the user from hunting for the other half.
        message="Delete this transfer? Both sides of it go, and both account balances go back."
        confirmLabel="Delete"
        pendingLabel="Deleting…"
        destructive
        isPending={deleteTransaction.isPending}
        errorMessage={deleteError}
        onConfirm={() => {
          void confirmDelete();
        }}
        onCancel={() => setConfirmingDelete(false)}
      />
    );
  }

  const pending =
    isSubmitting || createTransaction.isPending || updateTransaction.isPending;
  // A transfer needs TWO accounts; with fewer there is nothing valid to submit, so
  // the form says so instead of collecting amounts that cannot be saved. Archived
  // accounts do not count — they take no new operations. An unavailable list
  // (loading, error) blocks Save too: the pickers render why.
  const usable = accounts.filter((account) => !account.archived).length;
  const blocked =
    accountFieldBlocked(accountsPhase, accounts, transfer?.account_id) ||
    (!isEdit && usable < 2);

  return (
    <Modal
      title={isEdit ? 'Edit transfer' : 'New transfer'}
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

        {/* ONLY the "one account, and a transfer needs two" arm lives here. Every
            other account state — loading, a failed read, no account at all — is
            rendered by the pickers themselves, once each instead of three times. */}
        {accountsPhase === 'ready' && !isEdit && usable === 1 ? (
          <p className={styles.notice} role="status">
            A transfer moves money between two accounts — create a second one on the
            accounts screen first.
          </p>
        ) : null}

        <div className={styles.leg}>
          <AccountField
            id="transfer-source"
            label="From"
            registration={sourceReg}
            accounts={accounts}
            phase={accountsPhase}
            onRetry={retryAccounts}
            currentId={transfer?.account_id}
            errorMessage={errors.account_id?.message}
          />

          <div className={styles.field}>
            <label className={styles.label} htmlFor="transfer-amount">
              Amount sent{sourceCurrency ? ` (${sourceCurrency})` : ''}
            </label>
            <input
              id="transfer-amount"
              inputMode="decimal"
              className={errors.amount ? `${styles.input} ${styles.inputError}` : styles.input}
              aria-invalid={errors.amount ? true : undefined}
              {...register('amount')}
            />
            {errors.amount?.message ? (
              <p className={styles.fieldError} role="alert">
                {errors.amount.message}
              </p>
            ) : null}
          </div>
        </div>

        <p className={styles.arrow} aria-hidden="true">
          ↓
        </p>

        <div className={styles.leg}>
          <AccountField
            id="transfer-target"
            label="To"
            registration={targetReg}
            accounts={accounts}
            phase={accountsPhase}
            onRetry={retryAccounts}
            currentId={transfer?.counter_account_id}
            errorMessage={errors.counter_account_id?.message}
          />

          <div className={styles.field}>
            <label className={styles.label} htmlFor="transfer-counter-amount">
              Amount received{targetCurrency ? ` (${targetCurrency})` : ''}
            </label>
            <input
              id="transfer-counter-amount"
              inputMode="decimal"
              className={
                errors.counter_amount ? `${styles.input} ${styles.inputError}` : styles.input
              }
              aria-invalid={errors.counter_amount ? true : undefined}
              aria-describedby="transfer-counter-amount-hint"
              {...register('counter_amount')}
            />
            <p className={styles.hint} id="transfer-counter-amount-hint">
              What actually landed on the other account — your bank&apos;s real rate,
              fees included.
            </p>
            {errors.counter_amount?.message ? (
              <p className={styles.fieldError} role="alert">
                {errors.counter_amount.message}
              </p>
            ) : null}
          </div>
        </div>

        {/* The rate the SERVER computed from the two stored amounts (A2), shown
            verbatim as the string it sent. Never recomputed here — dividing one
            amount by the other would be exactly the client money arithmetic this
            project forbids — and only on edit, because before saving there is
            nothing stored to have a rate. Suppressed when both legs share a
            currency, matching transferDisplay's list rule: "1 USD per 1 USD" is
            noise, not information. */}
        {isEdit &&
        transfer?.transfer_rate !== null &&
        transfer?.transfer_rate !== undefined &&
        transfer.currency !== transfer.counter_currency ? (
          <p className={styles.rate} role="status">
            Rate at the time: {transfer.transfer_rate} {transfer.counter_currency} per 1{' '}
            {transfer.currency}
          </p>
        ) : null}

        <div className={styles.field}>
          <label className={styles.label} htmlFor="transfer-date">
            Date
          </label>
          <input
            id="transfer-date"
            type="date"
            className={
              errors.occurred_at ? `${styles.input} ${styles.inputError}` : styles.input
            }
            aria-invalid={errors.occurred_at ? true : undefined}
            {...register('occurred_at')}
          />
          {errors.occurred_at?.message ? (
            <p className={styles.fieldError} role="alert">
              {errors.occurred_at.message}
            </p>
          ) : null}
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="transfer-note">
            Note <span className={styles.hint}>(optional)</span>
          </label>
          <textarea
            id="transfer-note"
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
          {isEdit ? (
            <button
              type="button"
              className={styles.delete}
              onClick={() => {
                setDeleteError(undefined);
                setConfirmingDelete(true);
              }}
            >
              Delete
            </button>
          ) : null}
          <span className={styles.spacer} />
          <button type="submit" className={styles.submit} disabled={pending || blocked}>
            {pending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
