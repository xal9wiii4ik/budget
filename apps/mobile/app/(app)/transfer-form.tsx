// Money moved between two of the user's own accounts — ONE operation with two
// sides (addendum A1): two accounts, two amounts, one row, one delete.
//
// A separate route rather than a third `kind` branch of transaction-form: a
// transfer has no category and no base-currency snapshot (architecture §5), while
// it has a second account and a second amount that nothing else has. Keeping the
// transaction form's kind segment at expense/income also makes the server's
// KIND_CHANGE_UNSUPPORTED unreachable from this UI.
//
// The two amounts are entered INDEPENDENTLY, each in its own account's currency:
// that is the whole point — the user's real bank rate, fees included, not a market
// one. The client never divides one by the other; the resulting rate is a SERVER
// field (`transfer_rate`, addendum A2) and is only ever displayed verbatim.
import { zodResolver } from '@hookform/resolvers/zod';
import {
  formatApiDate,
  monthBounds,
  toApiDate,
  toInputString,
  todayApiDate,
  transferFormSchema,
  type TransferFormInput,
  type TransferFormValues,
} from '@budget/shared';
import { buildTransferPatch, emptyToNull } from '@budget/api-client';
import type { components } from '@budget/api-client';
import DateTimePicker, {
  type DateTimePickerChangeEvent,
} from '@react-native-community/datetimepicker';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState, type ReactNode } from 'react';
import { Controller, useForm, useWatch, type Resolver } from 'react-hook-form';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AccountPicker } from '../../src/components/AccountPicker';
import { confirmAction } from '../../src/components/confirm';
import { FieldError } from '../../src/components/FieldError';
import { FormButton } from '../../src/components/FormButton';
import { KeyboardAwareForm } from '../../src/components/KeyboardAwareForm';
import { LabeledInput } from '../../src/components/LabeledInput';
import { colors, spacing, TOUCH_TARGET } from '../../src/components/theme';
import { useAccounts, type AccountRead } from '../../src/data/accounts';
import {
  accountCurrencyLookup,
  buildAccountIndex,
  pickDefaultAccount,
  sortForDisplay,
} from '../../src/data/accountLookup';
import {
  MONTH_LIMIT,
  useCreateTransaction,
  useDeleteTransaction,
  useTransactions,
  useUpdateTransaction,
} from '../../src/data/transactions';
import { describeTransactionError } from '../../src/data/errors';
import { normalizeAmountInput } from '../../src/lib/amountInput';
import { APP_LOCALE } from '../../src/lib/locale';

type TransactionRead = components['schemas']['TransactionRead'];

// "YYYY-MM-DD" -> a LOCAL Date (component build, no UTC parse — TZ-safe like the
// shared date helpers), for feeding the native picker.
function apiDateToLocalDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export default function TransferFormScreen() {
  const params = useLocalSearchParams<{ id?: string; month?: string }>();
  const month = params.month ?? todayApiDate().slice(0, 7);
  const id = params.id;
  const isEdit = id !== undefined;

  const accountsQuery = useAccounts();

  // Deep-link-safe edit load: locate the row in the already-cached month list by
  // id (same filter slice => same query key => shared cache). No single-row GET
  // exists. The same list is what a CREATE reads its default account from.
  const bounds = monthBounds(month);
  const txQuery = useTransactions({ from: bounds.from, to: bounds.to, limit: MONTH_LIMIT });
  const cachedTransactions = useMemo(
    () => txQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [txQuery.data],
  );
  const transfer = isEdit
    ? cachedTransactions.find((tx) => tx.id === id && tx.kind === 'transfer')
    : undefined;

  // An account decides the currency each leg is denominated in, so the form waits
  // for the list rather than binding its defaults to an empty one (the picker
  // therefore has no loading arm of its own). Normally a cache hit.
  if (accountsQuery.isPending) {
    return (
      <Shell title={isEdit ? 'Edit transfer' : 'New transfer'}>
        <Text style={styles.notice}>Loading…</Text>
      </Shell>
    );
  }

  if (isEdit && txQuery.isPending) {
    return (
      <Shell title="Edit transfer">
        <Text style={styles.notice}>Loading…</Text>
      </Shell>
    );
  }

  // Cold deep link whose row isn't in the cached month (or isn't a transfer at
  // all): unavailable + back, never a create form in disguise.
  if (isEdit && transfer === undefined) {
    return (
      <Shell title="Edit transfer">
        <Text accessibilityRole="alert" style={styles.unavailable}>
          This transfer is unavailable.
        </Text>
        <FormButton label="Go back" variant="secondary" onPress={() => router.back()} />
      </Shell>
    );
  }

  return (
    <TransferFormBody
      transfer={transfer}
      accounts={accountsQuery.data ?? []}
      accountsError={accountsQuery.isError}
      onRetryAccounts={() => accountsQuery.refetch()}
      cachedTransactions={cachedTransactions}
    />
  );
}

interface BodyProps {
  transfer: TransactionRead | undefined;
  accounts: AccountRead[];
  accountsError: boolean;
  onRetryAccounts: () => void;
  cachedTransactions: TransactionRead[];
}

function TransferFormBody({
  transfer,
  accounts,
  accountsError,
  onRetryAccounts,
  cachedTransactions,
}: BodyProps) {
  const isEdit = transfer !== undefined;

  const createTransaction = useCreateTransaction();
  const updateTransaction = useUpdateTransaction();
  const deleteTransaction = useDeleteTransaction();
  const [showDatePicker, setShowDatePicker] = useState(false);

  const sorted = useMemo(() => sortForDisplay(accounts, APP_LOCALE), [accounts]);
  const byId = useMemo(() => buildAccountIndex(accounts), [accounts]);
  // Bound at render, not at submit: the exponent each amount parses with comes
  // from the account THAT leg belongs to, and an unknown id resolves to a field
  // error rather than a guessed exponent (AM-5).
  const currencyOf = useMemo(() => accountCurrencyLookup(accounts), [accounts]);

  const defaultValues: TransferFormInput = transfer
    ? {
        account_id: transfer.account_id,
        counter_account_id: transfer.counter_account_id ?? '',
        // AM-5: each leg decodes with the currency THAT LEG is denominated in —
        // `currency` for the source, `counter_currency` for the target (A5). No
        // `?? tx.currency` fallback: it would relabel money.
        amount: toInputString(transfer.amount_minor, transfer.currency),
        counter_amount:
          transfer.counter_amount_minor !== null && transfer.counter_currency !== null
            ? toInputString(transfer.counter_amount_minor, transfer.counter_currency)
            : '',
        occurred_at: transfer.occurred_at,
        note: transfer.note ?? '',
      }
    : {
        // The account of the most recent CACHED operation, else the only usable
        // one, else unpicked (data/accountLookup). Nothing is persisted on the
        // device for this (PM decision on OQ-M1), so a cold start simply starts
        // unpicked — a required field the user fills, not a wrong guess.
        account_id: pickDefaultAccount(accounts, cachedTransactions),
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

  // F-1: BOTH amounts go through the same normalization the transaction form
  // uses — a ru-RU decimal-pad can only type ','. The fields keep showing what was
  // typed; only what is validated/submitted is normalized.
  const resolver: Resolver<TransferFormInput, unknown, TransferFormValues> = (
    values,
    context,
    options,
  ) =>
    zodResolver(transferFormSchema(currencyOf))(
      {
        ...values,
        amount: normalizeAmountInput(values.amount),
        counter_amount: normalizeAmountInput(values.counter_amount),
      },
      context,
      options,
    );

  const {
    control,
    handleSubmit,
    setError,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<TransferFormInput, unknown, TransferFormValues>({ resolver, defaultValues });

  const sourceId = useWatch({ control, name: 'account_id' });
  const targetId = useWatch({ control, name: 'counter_account_id' });
  const occurredAt = useWatch({ control, name: 'occurred_at' });

  // Each amount input is labelled with the currency it will be read in, so the
  // user always knows which side of the rate they are typing.
  const sourceCurrency = byId.get(sourceId)?.currency;
  const targetCurrency = byId.get(targetId)?.currency;

  const onDateChange = (_event: DateTimePickerChangeEvent, date: Date) => {
    if (Platform.OS !== 'ios') setShowDatePicker(false);
    setValue('occurred_at', toApiDate(date));
  };

  const routeError = (error: unknown) => {
    const { field, message } = describeTransactionError(error);
    const target =
      field === 'form'
        ? 'root'
        : field === 'amount_minor'
          ? 'amount'
          : field === 'counter_amount_minor'
            ? 'counter_amount'
            : // A transfer has no category; a category-coded 422 here would be a
              // bug signal with no control to land on.
              field === 'category_id'
              ? 'root'
              : field;
    setError(target, { message });
  };

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
      }
      router.back();
    } catch (error) {
      routeError(error);
    }
  });

  const onDelete = () => {
    if (!transfer) return;
    confirmAction({
      title: 'Delete transfer',
      // A1: one operation, one delete — both sides go, and both balances move
      // back. Saying so is what stops the user hunting for the other half.
      message:
        'Delete this transfer? Both sides of it go, and both account balances go back.',
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: () => {
        deleteTransaction.mutate(
          { id: transfer.id, occurredAt: transfer.occurred_at },
          { onSuccess: () => router.back(), onError: routeError },
        );
      },
    });
  };

  const pending = isSubmitting || createTransaction.isPending || updateTransaction.isPending;
  // A transfer needs TWO usable accounts; with fewer there is nothing valid to
  // submit, so the form says so instead of collecting amounts that cannot be
  // saved. An unavailable list (loading, error) blocks Save too — the pickers
  // render why.
  const usable = accounts.filter((account) => !account.archived).length;
  const blocked = accountsError || (!isEdit && usable < 2);

  return (
    <Shell title={isEdit ? 'Edit transfer' : 'New transfer'}>
      <FieldError message={errors.root?.message} />

      {!accountsError && !isEdit && usable < 2 ? (
        <Text style={styles.notice}>
          A transfer moves money between two accounts — create a second one on the
          Accounts tab first.
        </Text>
      ) : null}

      <AccountPicker
        label="From"
        accounts={sorted}
        isError={accountsError}
        onRetry={onRetryAccounts}
        value={sourceId}
        onChange={(accountId) => setValue('account_id', accountId)}
        currentId={transfer?.account_id}
        error={errors.account_id?.message}
      />

      <Controller
        control={control}
        name="amount"
        render={({ field }) => (
          <LabeledInput
            label={`Amount sent${sourceCurrency ? ` (${sourceCurrency})` : ''}`}
            keyboardType="decimal-pad"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={errors.amount?.message}
          />
        )}
      />

      <Text style={styles.arrow}>↓</Text>

      <AccountPicker
        label="To"
        accounts={sorted}
        isError={accountsError}
        onRetry={onRetryAccounts}
        value={targetId}
        onChange={(accountId) => setValue('counter_account_id', accountId)}
        currentId={transfer?.counter_account_id}
        error={errors.counter_account_id?.message}
      />

      <Controller
        control={control}
        name="counter_amount"
        render={({ field }) => (
          <LabeledInput
            label={`Amount received${targetCurrency ? ` (${targetCurrency})` : ''}`}
            keyboardType="decimal-pad"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            hint="What actually landed on the other account — your bank's real rate, fees included."
            error={errors.counter_amount?.message}
          />
        )}
      />

      {/* The rate the SERVER computed from the two stored amounts (A2), shown
          verbatim as the string it sent. Never recomputed here — dividing one
          amount by the other would be exactly the client money arithmetic this
          project forbids — and only on edit, because before saving there is
          nothing stored to have a rate. */}
      {isEdit && transfer?.transfer_rate ? (
        <Text style={styles.rate}>
          Rate at the time: {transfer.transfer_rate} {transfer.counter_currency} per 1{' '}
          {transfer.currency}
        </Text>
      ) : null}

      <View style={styles.field}>
        <Text style={styles.label}>Date</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => setShowDatePicker(true)}
          style={styles.dateButton}
        >
          <Text style={styles.dateText}>
            {formatApiDate(occurredAt, { locale: APP_LOCALE })}
          </Text>
        </Pressable>
        {showDatePicker ? (
          <>
            <DateTimePicker
              value={apiDateToLocalDate(occurredAt)}
              mode="date"
              display={Platform.OS === 'ios' ? 'inline' : 'default'}
              onValueChange={onDateChange}
              onDismiss={() => setShowDatePicker(false)}
            />
            {Platform.OS === 'ios' ? (
              <FormButton
                label="Done"
                variant="secondary"
                onPress={() => setShowDatePicker(false)}
              />
            ) : null}
          </>
        ) : null}
        <FieldError message={errors.occurred_at?.message} />
      </View>

      <Controller
        control={control}
        name="note"
        render={({ field }) => (
          <LabeledInput
            label="Note (optional)"
            multiline
            maxLength={500}
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={errors.note?.message}
            style={styles.noteInput}
          />
        )}
      />

      <FormButton label="Save" onPress={onSubmit} pending={pending} disabled={blocked} />
      {isEdit ? (
        <FormButton
          label="Delete"
          variant="danger"
          onPress={onDelete}
          pending={deleteTransaction.isPending}
        />
      ) : null}
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" onPress={() => router.back()} hitSlop={8}>
          <Text style={styles.cancel}>Cancel</Text>
        </Pressable>
        <Text style={styles.title}>{title}</Text>
        <View style={styles.headerSpacer} />
      </View>
      <KeyboardAwareForm>{children}</KeyboardAwareForm>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.card,
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.text,
  },
  cancel: {
    fontSize: 16,
    color: colors.primary,
    minWidth: 60,
  },
  headerSpacer: {
    minWidth: 60,
  },
  field: {
    gap: spacing.xs,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
  },
  notice: {
    color: colors.textMuted,
    fontSize: 14,
  },
  unavailable: {
    color: colors.danger,
    fontSize: 15,
  },
  arrow: {
    fontSize: 20,
    color: colors.textMuted,
    textAlign: 'center',
  },
  rate: {
    fontSize: 13,
    color: colors.textMuted,
  },
  dateButton: {
    minHeight: TOUCH_TARGET,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
    backgroundColor: colors.card,
  },
  dateText: {
    fontSize: 16,
    color: colors.text,
  },
  noteInput: {
    minHeight: 88,
    textAlignVertical: 'top',
  },
});
