import { zodResolver } from '@hookform/resolvers/zod';
import {
  formatApiDate,
  multiCurrencyTransactionFormSchema,
  parseMoney,
  toInputString,
  todayApiDate,
  type MultiCurrencyTransactionFormInput,
  type MultiCurrencyTransactionFormValues,
} from '@budget/shared';
import type { components } from '@budget/api-client';
import { useEffect, useState, type ChangeEvent } from 'react';
import { useForm, useWatch } from 'react-hook-form';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { CurrencySelect } from '../../components/CurrencySelect';
import { Modal } from '../../components/Modal';
import { sortForDisplay } from '../../data/categoryLookup';
import { useFxPreview } from '../../data/fx';
import type { FxConvertParams } from '../../data/fx';
import {
  useCreateTransaction,
  useDeleteTransaction,
  useSummary,
  useUpdateTransaction,
} from '../../data/transactions';
import { describeTransactionError } from '../../lib/errors';
import { useDebouncedValue } from '../../lib/useDebouncedValue';
import { buildTransactionPatch } from '@budget/api-client';
import {
  buildCreateBody,
  editPrefillBaseAmount,
  previewAutofillValue,
  shouldShowConvertedSection,
} from './convertedSection';
import styles from './TransactionFormModal.module.css';

type CategoryRead = components['schemas']['CategoryRead'];
type TransactionRead = components['schemas']['TransactionRead'];

// occurred_at as the date input produces it; a half-typed date must not be sent
// to the preview endpoint.
const API_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// A preview per keystroke would be pure waste — rates are daily rows.
const PREVIEW_DEBOUNCE_MS = 300;

interface TransactionFormModalProps {
  month: string; // selected month, source of the base currency (via summary)
  transaction?: TransactionRead; // undefined = create mode
  categories: CategoryRead[]; // archived-inclusive set
  onClose: () => void;
}

/**
 * Shell: resolves the PROFILE BASE currency before the form exists.
 *
 * Since 3.2 the base currency is not cosmetic — it decides whether the converted
 * section is shown, which exponent `base_amount` parses with, and whether
 * `base_amount_minor` may go on the wire at all. There is no safe default (a
 * guessed base is the AM-5 sin), and the row's own `currency` is now the
 * TRANSACTION currency, so it cannot stand in either. Both create AND edit
 * therefore wait for the summary — which the transactions page has already
 * fetched for this month, so this is a cache hit in the normal flow.
 */
export function TransactionFormModal({
  month,
  transaction,
  categories,
  onClose,
}: TransactionFormModalProps) {
  const summary = useSummary(month);
  const baseCurrency = summary.data?.currency;
  const title = transaction ? 'Edit transaction' : 'New transaction';

  if (baseCurrency === undefined) {
    return (
      <Modal title={title} onClose={onClose}>
        {summary.isError ? (
          <p className={styles.formError} role="alert">
            Couldn&apos;t load your account currency. Close this and try again.
          </p>
        ) : (
          <p className={styles.notice} role="status">
            Loading account currency…
          </p>
        )}
      </Modal>
    );
  }

  return (
    <TransactionForm
      baseCurrency={baseCurrency}
      transaction={transaction}
      categories={categories}
      onClose={onClose}
    />
  );
}

interface TransactionFormProps {
  baseCurrency: string;
  transaction?: TransactionRead;
  categories: CategoryRead[];
  onClose: () => void;
}

function TransactionForm({
  baseCurrency,
  transaction,
  categories,
  onClose,
}: TransactionFormProps) {
  const isEdit = transaction !== undefined;

  const createTransaction = useCreateTransaction();
  const updateTransaction = useUpdateTransaction();
  const deleteTransaction = useDeleteTransaction();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined);

  // The converted field's dirty flag is EXPLICIT, not RHF's `isDirty`: isDirty
  // compares against defaultValues, so a user who edits the field and then retypes
  // the default would silently flip back to "auto" and previews would resume
  // overwriting their number. This flag is set by a real keystroke only.
  const [baseAmountEdited, setBaseAmountEdited] = useState(false);

  // AM-5: decoded with the snapshot's own paired currency; "" when absent or when
  // the pair's base no longer matches the profile base (stale-base bypass).
  const basePrefill = transaction ? editPrefillBaseAmount(transaction, baseCurrency) : '';

  const defaultValues: MultiCurrencyTransactionFormInput = transaction
    ? {
        amount: toInputString(transaction.amount_minor, transaction.currency),
        currency: transaction.currency,
        base_amount: basePrefill,
        kind: transaction.kind,
        category_id: transaction.category_id ?? '',
        occurred_at: transaction.occurred_at,
        note: transaction.note ?? '',
      }
    : {
        amount: '',
        currency: baseCurrency,
        base_amount: '',
        kind: 'expense',
        category_id: '',
        occurred_at: todayApiDate(),
        note: '',
      };

  // Output-shaped initial values for the PATCH diff. `base_amount_minor` mirrors
  // what the FIELD shows: a hidden stale-base snapshot is `null` here too, so
  // leaving the field untouched diffs to "unchanged" and sends nothing.
  const initial: MultiCurrencyTransactionFormValues = {
    amount: transaction?.amount_minor ?? 0,
    // NOT a decode fallback (AM-5): this is the diff BASELINE, and the create
    // branch (no transaction) never reaches the patch builder at all.
    currency: transaction?.currency ?? baseCurrency,
    base_amount_minor: basePrefill === '' ? null : (transaction?.base_amount_minor ?? null),
    kind: transaction?.kind ?? 'expense',
    category_id: transaction?.category_id ?? '',
    occurred_at: transaction?.occurred_at ?? '',
    note: transaction?.note ?? '',
  };

  const {
    control,
    register,
    handleSubmit,
    setError,
    setValue,
    getValues,
    formState: { errors, dirtyFields, isSubmitting },
  } = useForm<MultiCurrencyTransactionFormInput, unknown, MultiCurrencyTransactionFormValues>({
    // The resolver identity no longer depends on the SELECTED currency: the
    // amount's exponent follows the in-form `currency` value inside the schema,
    // and only the base currency (stable for this modal) is bound here.
    resolver: zodResolver(multiCurrencyTransactionFormSchema(baseCurrency)),
    defaultValues,
  });

  // useWatch (not the destructured `watch`): it subscribes as a hook and returns
  // values, which the React Compiler can reason about.
  const currency = useWatch({ control, name: 'currency' });
  const amountRaw = useWatch({ control, name: 'amount' });
  const occurredAt = useWatch({ control, name: 'occurred_at' });
  const showConverted = shouldShowConvertedSection(currency, baseCurrency);

  // Debounce the TYPED inputs only; a currency pick is discrete and fires at once.
  const debouncedAmount = useDebouncedValue(amountRaw, PREVIEW_DEBOUNCE_MS);
  const debouncedDate = useDebouncedValue(occurredAt, PREVIEW_DEBOUNCE_MS);
  const previewAmount = parseMoney(debouncedAmount, currency);

  // Create-mode only (Disagreement 2): in edit mode the STORED snapshot is the
  // truth on screen, and an unsolicited overwrite of a user-owned override is
  // exactly what the dirty flag exists to prevent. `parseMoney` here ENCODES the
  // query parameter — the client still never multiplies by a rate (D8).
  const previewParams: FxConvertParams | null =
    !isEdit && showConverted && previewAmount.ok && API_DATE_PATTERN.test(debouncedDate)
      ? { amountMinor: previewAmount.minor, from: currency, to: baseCurrency, date: debouncedDate }
      : null;
  const preview = useFxPreview(previewParams);
  const previewResult = preview.data;

  // Server result -> form state. Runs only while the field is untouched; once the
  // user types, previews never write again. A result WITHOUT a rate writes "" —
  // it clears a previous autofill rather than leaving a number the server will not
  // store (see `previewAutofillValue`). While a new preview is in flight there is
  // no result yet, so the field simply holds still.
  useEffect(() => {
    if (isEdit || baseAmountEdited) return;
    if (previewResult === undefined) return;
    setValue('base_amount', previewAutofillValue(previewResult), {
      shouldDirty: false,
      shouldValidate: false,
    });
  }, [previewResult, baseAmountEdited, isEdit, setValue]);

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
  const currencyReg = register('currency');
  const baseAmountReg = register('base_amount');

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

  // A different currency invalidates whatever stood in the converted field: an
  // autofilled preview, a typed override, and (in edit mode) the stored snapshot,
  // which belongs to the ORIGINAL currency. Switching back to the row's currency
  // restores the stored value.
  const onCurrencyChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const restored =
      transaction && event.target.value === transaction.currency ? basePrefill : '';
    setValue('base_amount', restored, { shouldDirty: true, shouldValidate: false });
    setBaseAmountEdited(false);
  };

  const onBaseAmountChange = (event: ChangeEvent<HTMLInputElement>) => {
    void baseAmountReg.onChange(event);
    setBaseAmountEdited(true);
  };

  const resetToAuto = () => {
    setValue('base_amount', '', { shouldDirty: true, shouldValidate: false });
    setBaseAmountEdited(false);
  };

  // Honest surface of what the server will do with the converted amount.
  const conversionInputDirty = Boolean(
    dirtyFields.amount || dirtyFields.currency || dirtyFields.occurred_at,
  );
  const convertedHints: string[] = [];
  if (isEdit) {
    if (conversionInputDirty && !baseAmountEdited) {
      // PATCH row 6: any conversion input moving makes the server recompute.
      convertedHints.push(
        API_DATE_PATTERN.test(occurredAt)
          ? `Will be recalculated at the ${formatApiDate(occurredAt)} rate when you save.`
          : 'Will be recalculated when you save.',
      );
    }
  } else if (previewParams !== null) {
    if (preview.isPending) {
      convertedHints.push('Converting…');
    } else if (preview.isError) {
      convertedHints.push(
        `Couldn't fetch a rate right now. You can enter the ${baseCurrency} amount yourself.`,
      );
    } else if (previewResult) {
      const rate = previewResult.rate;
      const rateAsOf = previewResult.rate_as_of;
      if (previewResult.converted_minor === null || rate === null || rateAsOf === null) {
        // Degradation, not failure: the field stays enabled and a typed value is
        // stored as the override, so an unsupported currency remains usable.
        convertedHints.push(
          `No exchange rate available for ${currency}→${baseCurrency}. You can enter the ${baseCurrency} amount yourself.`,
        );
      } else {
        // D2's disclosed rate date: shows when a weekend/stale rate was used.
        // `rate` is rendered VERBATIM (a server-quantized decimal string — never
        // reformatted, never parsed); only its date goes through the shared
        // locale formatter. No sentence period: locales like ru end the formatted
        // date in "г." and the template would double it ("… 2026 г..").
        convertedHints.push(
          `Rate ${rate} as of ${
            API_DATE_PATTERN.test(rateAsOf) ? formatApiDate(rateAsOf) : rateAsOf
          }`,
        );
        if (!baseAmountEdited) {
          convertedHints.push('≈ Estimate — the exact amount is computed when you save.');
        }
      }
    }
  }

  const onSubmit = handleSubmit(async (values) => {
    try {
      if (isEdit && transaction) {
        const patch = buildTransactionPatch(values, initial, baseCurrency);
        if (Object.keys(patch).length > 0) {
          await updateTransaction.mutateAsync({
            id: transaction.id,
            body: patch,
            previousOccurredAt: transaction.occurred_at,
          });
        }
      } else {
        await createTransaction.mutateAsync(
          buildCreateBody(values, baseCurrency, baseAmountEdited),
        );
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
            <label className={styles.srOnly} htmlFor="tx-currency">
              Currency
            </label>
            <CurrencySelect
              id="tx-currency"
              registration={currencyReg}
              onChange={onCurrencyChange}
              // An edit of a row whose currency is outside the supported set
              // (e.g. a receipt confirmed in JPY) must keep it selectable.
              extraCurrency={transaction?.currency}
            />
          </div>
          {errors.amount?.message ? (
            <p className={styles.fieldError} role="alert">
              {errors.amount.message}
            </p>
          ) : null}
          {errors.currency?.message ? (
            <p className={styles.fieldError} role="alert">
              {errors.currency.message}
            </p>
          ) : null}
        </div>

        {showConverted ? (
          <fieldset className={styles.converted}>
            <legend className={styles.label}>Amount in {baseCurrency}</legend>
            <div className={styles.amountRow}>
              <input
                id="tx-base-amount"
                inputMode="decimal"
                className={
                  errors.base_amount ? `${styles.input} ${styles.inputError}` : styles.input
                }
                aria-invalid={errors.base_amount ? true : undefined}
                aria-describedby="tx-base-amount-hint"
                {...baseAmountReg}
                onChange={onBaseAmountChange}
              />
              <button type="button" className={styles.resetAuto} onClick={resetToAuto}>
                Reset to auto
              </button>
            </div>
            {errors.base_amount?.message ? (
              <p className={styles.fieldError} role="alert">
                {errors.base_amount.message}
              </p>
            ) : null}
            <p className={styles.hint} id="tx-base-amount-hint" role="status">
              {convertedHints.length > 0
                ? convertedHints.join(' ')
                : `Leave this empty to have the ${baseCurrency} amount calculated for you.`}
            </p>
          </fieldset>
        ) : null}

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
          <button type="submit" className={styles.submit} disabled={pending}>
            {pending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
