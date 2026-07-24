import { zodResolver } from '@hookform/resolvers/zod';
import {
  toInputString,
  todayApiDate,
  transactionFormSchema,
  type TransactionFormInput,
  type TransactionFormValues,
} from '@budget/shared';
import type { components } from '@budget/api-client';
import { useState, type ChangeEvent } from 'react';
import { useForm } from 'react-hook-form';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Modal } from '../../components/Modal';
import { sortForDisplay } from '../../data/categoryLookup';
import {
  useCreateTransaction,
  useDeleteTransaction,
  useSummary,
  useUpdateTransaction,
} from '../../data/transactions';
import { describeTransactionError } from '../../lib/errors';
import { buildTransactionPatch, emptyToNull } from '@budget/api-client';
import styles from './TransactionFormModal.module.css';

type CategoryRead = components['schemas']['CategoryRead'];
type TransactionRead = components['schemas']['TransactionRead'];

interface TransactionFormModalProps {
  month: string; // selected month, source of the create-form currency (via summary)
  transaction?: TransactionRead; // undefined = create mode
  categories: CategoryRead[]; // archived-inclusive set
  onClose: () => void;
}

export function TransactionFormModal({
  month,
  transaction,
  categories,
  onClose,
}: TransactionFormModalProps) {
  const isEdit = transaction !== undefined;

  // Currency is display-only and never collected (T8). Edit uses the row's own
  // currency; create sources it from the month summary (already fetched for the
  // header). Until it resolves, the create form is degraded: submit disabled.
  const summary = useSummary(month);
  const currency = transaction?.currency ?? summary.data?.currency;
  const currencyKnown = currency !== undefined;
  const schemaCurrency = currency ?? 'USD';
  const createDegraded = !isEdit && !currencyKnown;

  const createTransaction = useCreateTransaction();
  const updateTransaction = useUpdateTransaction();
  const deleteTransaction = useDeleteTransaction();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined);

  const defaultValues: TransactionFormInput = transaction
    ? {
        amount: toInputString(transaction.amount_minor, transaction.currency),
        kind: transaction.kind,
        category_id: transaction.category_id ?? '',
        occurred_at: transaction.occurred_at,
        note: transaction.note ?? '',
      }
    : {
        amount: '',
        kind: 'expense',
        category_id: '',
        occurred_at: todayApiDate(),
        note: '',
      };

  // Output-shaped initial values for the PATCH diff (amount as parsed minor units).
  const initial: TransactionFormValues = {
    amount: transaction?.amount_minor ?? 0,
    kind: transaction?.kind ?? 'expense',
    category_id: transaction?.category_id ?? '',
    occurred_at: transaction?.occurred_at ?? '',
    note: transaction?.note ?? '',
  };

  const {
    register,
    handleSubmit,
    setError,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<TransactionFormInput, unknown, TransactionFormValues>({
    resolver: zodResolver(transactionFormSchema(schemaCurrency)),
    defaultValues,
  });

  // Picker lists non-archived categories; an edit whose saved category is archived
  // keeps that archived category selectable as the current value (1.4 decision e).
  const nonArchived = categories.filter((category) => !category.archived);
  const currentCategory = transaction?.category_id
    ? categories.find((category) => category.id === transaction.category_id)
    : undefined;
  const options =
    currentCategory?.archived ? [...nonArchived, currentCategory] : nonArchived;
  const sortedOptions = sortForDisplay(options);
  const expenseOptions = sortedOptions.filter((category) => category.kind === 'expense');
  const incomeOptions = sortedOptions.filter((category) => category.kind === 'income');

  const categoryReg = register('category_id');
  const kindReg = register('kind');

  // Kind-agnostic (reads event.target.value): flipping the kind clears a selected
  // category whose kind no longer matches. Shared by both kind radios.
  const onKindChange = (event: ChangeEvent<HTMLInputElement>) => {
    void kindReg.onChange(event);
    const selectedId = getValues('category_id');
    const selected = categories.find((category) => category.id === selectedId);
    if (selected && selected.kind !== event.target.value) {
      setValue('category_id', '');
    }
  };

  const onSubmit = handleSubmit(async (values) => {
    try {
      if (isEdit && transaction) {
        const patch = buildTransactionPatch(values, initial);
        if (Object.keys(patch).length > 0) {
          await updateTransaction.mutateAsync({
            id: transaction.id,
            body: patch,
            previousOccurredAt: transaction.occurred_at,
          });
        }
      } else {
        await createTransaction.mutateAsync({
          amount_minor: values.amount,
          kind: values.kind,
          category_id: emptyToNull(values.category_id),
          occurred_at: values.occurred_at,
          note: emptyToNull(values.note),
        });
      }
      onClose();
    } catch (error) {
      // The 404 (TRANSACTION_NOT_FOUND) list refetch is handled by the mutation's
      // onError in data/transactions.ts; here we only route the error to the form.
      const { field, message } = describeTransactionError(error);
      const target = field === 'form' ? 'root' : field === 'amount_minor' ? 'amount' : field;
      setError(target, { message });
    }
  });

  const confirmDelete = async () => {
    if (!transaction) return;
    setDeleteError(undefined);
    try {
      await deleteTransaction.mutateAsync({
        id: transaction.id,
        occurredAt: transaction.occurred_at,
      });
      onClose();
    } catch (error) {
      setDeleteError(describeTransactionError(error).message);
    }
  };

  if (confirmingDelete && transaction) {
    return (
      <ConfirmDialog
        title="Delete transaction"
        message="Delete this transaction? This can't be undone."
        confirmLabel="Delete"
        pendingLabel="Deleting…"
        destructive
        isPending={deleteTransaction.isPending}
        errorMessage={deleteError}
        onConfirm={confirmDelete}
        onCancel={() => setConfirmingDelete(false)}
      />
    );
  }

  const pending =
    isSubmitting || createTransaction.isPending || updateTransaction.isPending;

  return (
    <Modal title={isEdit ? 'Edit transaction' : 'New transaction'} onClose={onClose}>
      <form className={styles.form} onSubmit={onSubmit} noValidate>
        {errors.root?.message ? (
          <p className={styles.formError} role="alert">
            {errors.root.message}
          </p>
        ) : null}

        {createDegraded ? (
          <p className={styles.notice} role="status">
            Loading account currency…
          </p>
        ) : null}

        <div className={styles.field}>
          <label className={styles.label} htmlFor="tx-amount">
            Amount
          </label>
          <div className={styles.amountRow}>
            <input
              id="tx-amount"
              inputMode="decimal"
              className={errors.amount ? `${styles.input} ${styles.inputError}` : styles.input}
              aria-invalid={errors.amount ? true : undefined}
              {...register('amount')}
            />
            {currencyKnown ? <span className={styles.currencyChip}>{currency}</span> : null}
          </div>
          {errors.amount?.message ? (
            <p className={styles.fieldError} role="alert">
              {errors.amount.message}
            </p>
          ) : null}
        </div>

        <fieldset className={styles.field}>
          <legend className={styles.label}>Type</legend>
          <div className={styles.kindGroup}>
            <label className={styles.kindOption}>
              <input type="radio" value="expense" {...kindReg} onChange={onKindChange} />
              Expense
            </label>
            <label className={styles.kindOption}>
              <input type="radio" value="income" {...kindReg} onChange={onKindChange} />
              Income
            </label>
          </div>
        </fieldset>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="tx-category">
            Category <span className={styles.hint}>(optional)</span>
          </label>
          <select
            id="tx-category"
            className={styles.select}
            {...categoryReg}
            onChange={(event) => {
              void categoryReg.onChange(event);
              const picked = categories.find((category) => category.id === event.target.value);
              if (picked) setValue('kind', picked.kind);
            }}
          >
            <option value="">Uncategorized</option>
            {expenseOptions.length > 0 ? (
              <optgroup label="Expense">
                {expenseOptions.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                    {category.archived ? ' (archived)' : ''}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {incomeOptions.length > 0 ? (
              <optgroup label="Income">
                {incomeOptions.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                    {category.archived ? ' (archived)' : ''}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
          {errors.category_id?.message ? (
            <p className={styles.fieldError} role="alert">
              {errors.category_id.message}
            </p>
          ) : null}
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="tx-date">
            Date
          </label>
          <input
            id="tx-date"
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
          <label className={styles.label} htmlFor="tx-note">
            Note <span className={styles.hint}>(optional)</span>
          </label>
          <textarea
            id="tx-note"
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
          <button type="submit" className={styles.submit} disabled={pending || createDegraded}>
            {pending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
