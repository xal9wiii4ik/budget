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
  mirrorDecision,
  monthBounds,
  toApiDate,
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
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import { useLang, useLocale, useT } from '../../src/i18n/context';
import { normalizeAmountInput, toLocalInputString } from '../../src/lib/amountInput';

type TransactionRead = components['schemas']['TransactionRead'];

// "YYYY-MM-DD" -> a LOCAL Date (component build, no UTC parse — TZ-safe like the
// shared date helpers), for feeding the native picker.
function apiDateToLocalDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export default function TransferFormScreen() {
  const t = useT();
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
      <Shell title={t(isEdit ? 'transfer.editTitle' : 'transfer.newTitle')}>
        <Text style={styles.notice}>{t('common.loading')}</Text>
      </Shell>
    );
  }

  if (isEdit && txQuery.isPending) {
    return (
      <Shell title={t('transfer.editTitle')}>
        <Text style={styles.notice}>{t('common.loading')}</Text>
      </Shell>
    );
  }

  // Cold deep link whose row isn't in the cached month (or isn't a transfer at
  // all): unavailable + back, never a create form in disguise.
  if (isEdit && transfer === undefined) {
    return (
      <Shell title={t('transfer.editTitle')}>
        <Text accessibilityRole="alert" style={styles.unavailable}>
          {t('transfer.unavailable')}
        </Text>
        <FormButton
          label={t('common.goBack')}
          variant="secondary"
          onPress={() => router.back()}
        />
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
  const t = useT();
  // Formatters follow the INTERFACE language, and the shared error copy is
  // rendered in it too.
  const locale = useLocale();
  const lang = useLang();
  const isEdit = transfer !== undefined;

  const createTransaction = useCreateTransaction();
  const updateTransaction = useUpdateTransaction();
  const deleteTransaction = useDeleteTransaction();
  const [showDatePicker, setShowDatePicker] = useState(false);

  const sorted = useMemo(() => sortForDisplay(accounts, locale), [accounts, locale]);
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
        // N-5 (catch-up 3, line B): written with the separator THIS language's
        // keyboard can type — a ru decimal-pad has no '.' key, so a machine
        // "120.00" is a value the user cannot correct. `normalizeAmountInput` in
        // the resolver maps it straight back.
        amount: toLocalInputString(transfer.amount_minor, transfer.currency, lang),
        counter_amount:
          transfer.counter_amount_minor !== null && transfer.counter_currency !== null
            ? toLocalInputString(
                transfer.counter_amount_minor,
                transfer.counter_currency,
                lang,
              )
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
    trigger,
    formState: { errors, isSubmitting },
  } = useForm<TransferFormInput, unknown, TransferFormValues>({ resolver, defaultValues });

  // N-3 (catch-up 3, line B): "Pick a different account to transfer to." is an
  // error about the PAIR, but react-hook-form attributes it to one field, and in
  // onSubmit mode a field is only revalidated when IT changes — so fixing the
  // clash on the OTHER side left the message standing until the next submit.
  // Changing either account therefore revalidates the other one. Mobile-only:
  // the same message on web is left as it is (its fix is a revalidation-mode
  // decision for every form on both clients, follow-up N-3 of catch-up 1).
  //
  // `trigger` on a not-yet-validated field is a no-op — nothing shows an error
  // that the user has not submitted at least once.
  const pickAccount = (
    field: 'account_id' | 'counter_account_id',
    counterpart: 'account_id' | 'counter_account_id',
    accountId: string,
  ) => {
    setValue(field, accountId, { shouldValidate: true });
    void trigger(counterpart);
  };

  const sourceId = useWatch({ control, name: 'account_id' });
  const targetId = useWatch({ control, name: 'counter_account_id' });
  const occurredAt = useWatch({ control, name: 'occurred_at' });

  // Each amount input is labelled with the currency it will be read in, so the
  // user always knows which side of the rate they are typing.
  const sourceCurrency = byId.get(sourceId)?.currency;
  const targetCurrency = byId.get(targetId)?.currency;

  // Legs denominated alike let the form fill the received amount in — the same
  // wiring the web modal has (TransferFormModal), over the same shared rule.
  // `mirrorDecision` holds the whole rule and the reason it is a rule rather than
  // a "has this field been touched" flag; edit mode needs no special case here,
  // because a stored counter amount is by definition not the mirror's own value
  // and the ownership rule therefore leaves it alone.
  const sentAmount = useWatch({ control, name: 'amount' });
  const counterAmount = useWatch({ control, name: 'counter_amount' });
  // False while EITHER account is still unknown: "same currency" must be a fact
  // about two accounts, not the accident of two undefineds matching.
  const sameCurrency = sourceCurrency !== undefined && sourceCurrency === targetCurrency;
  // The mirror's receipt: what it wrote last, and therefore the only value it may
  // overwrite. A ref rather than state — it renders nothing, it only remembers.
  const mirrored = useRef<string | null>(null);

  useEffect(() => {
    const next = mirrorDecision({
      sameCurrency,
      sentAmount,
      counterAmount,
      mirrored: mirrored.current,
    });
    if (next === null) return;
    mirrored.current = next;
    // The RAW typed string is mirrored verbatim, separator and all: on a ru-RU
    // keyboard the sent field can only contain "100,5", and restating it as
    // "100.5" would show the user a separator their keyboard cannot produce —
    // next to the number they just typed. Normalisation stays where it already
    // is, in the resolver (`normalizeAmountInput`), so both sides are still
    // parsed by the shared schema in exactly one form.
    setValue('counter_amount', next, { shouldDirty: false });
  }, [sameCurrency, sentAmount, counterAmount, setValue]);

  const onDateChange = (_event: DateTimePickerChangeEvent, date: Date) => {
    if (Platform.OS !== 'ios') setShowDatePicker(false);
    setValue('occurred_at', toApiDate(date));
  };

  const routeError = (error: unknown) => {
    const { field, message } = describeTransactionError(error, lang);
    const target =
      field === 'form'
        ? 'root'
        : field === 'amount_minor'
          ? 'amount'
          : field === 'counter_amount_minor'
            ? 'counter_amount'
            : // A transfer has neither a category, a name nor a plan item; a 422
              // coded for any of them would be a bug signal with no control to
              // land on. (`goal_item_id` joined the table in catch-up 3 line C —
              // the server accepts an attachment on EXPENSES only, so a transfer
              // can never legitimately collect one.)
              field === 'category_id' ||
                field === 'merchant' ||
                field === 'goal_item_id'
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
            // catch-up 3, line C: a transfer can never be attached to a plan item
            // (the server accepts an attachment on EXPENSES only), so the pre-edit
            // value is a fact, not a fallback.
            previousGoalItemId: null,
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
      cancelLabel: t('common.cancel'),
      title: t('transfer.deleteTitle'),
      // A1: one operation, one delete — both sides go, and both balances move
      // back. Saying so is what stops the user hunting for the other half.
      message: t('transfer.deleteMessage'),
      confirmLabel: t('common.delete'),
      destructive: true,
      onConfirm: () => {
        deleteTransaction.mutate(
          // `previousGoalItemId: null` — a transfer is never attached to a plan
          // item (catch-up 3, line C).
          { id: transfer.id, occurredAt: transfer.occurred_at, previousGoalItemId: null },
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
    <Shell
      title={t(isEdit ? 'transfer.editTitle' : 'transfer.newTitle')}
      footer={
        <>
          <FormButton
            label={t('common.save')}
            onPress={onSubmit}
            pending={pending}
            disabled={blocked}
          />
          {isEdit ? (
            <FormButton
              label={t('common.delete')}
              variant="danger"
              onPress={onDelete}
              pending={deleteTransaction.isPending}
            />
          ) : null}
        </>
      }
    >
      <FieldError message={errors.root?.message} />

      {!accountsError && !isEdit && usable < 2 ? (
        <Text style={styles.notice}>{t('transfer.needTwoAccounts')}</Text>
      ) : null}

      <AccountPicker
        label={t('transfer.from')}
        accounts={sorted}
        isError={accountsError}
        onRetry={onRetryAccounts}
        value={sourceId}
        onChange={(accountId) => pickAccount('account_id', 'counter_account_id', accountId)}
        currentId={transfer?.account_id}
        error={errors.account_id?.message}
      />

      <Controller
        control={control}
        name="amount"
        render={({ field }) => (
          <LabeledInput
            label={
              sourceCurrency === undefined
                ? t('transfer.amountSent')
                : t('transfer.amountSentIn', { currency: sourceCurrency })
            }
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
        label={t('transfer.to')}
        accounts={sorted}
        isError={accountsError}
        onRetry={onRetryAccounts}
        value={targetId}
        onChange={(accountId) => pickAccount('counter_account_id', 'account_id', accountId)}
        currentId={transfer?.counter_account_id}
        error={errors.counter_account_id?.message}
      />

      <Controller
        control={control}
        name="counter_amount"
        render={({ field }) => (
          <LabeledInput
            label={
              targetCurrency === undefined
                ? t('transfer.amountReceived')
                : t('transfer.amountReceivedIn', { currency: targetCurrency })
            }
            keyboardType="decimal-pad"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            hint={t('transfer.receivedHint')}
            error={errors.counter_amount?.message}
          />
        )}
      />

      {/* The rate the SERVER computed from the two stored amounts (A2), shown
          verbatim as the string it sent. Never recomputed here — dividing one
          amount by the other would be exactly the client money arithmetic this
          project forbids — and only on edit, because before saving there is
          nothing stored to have a rate.
          Hidden when both legs share a currency: the server sends "1" there and
          "1 USD per 1 USD" is noise, not information — same rule as web (D-2). */}
      {isEdit && transfer?.transfer_rate && transfer.counter_currency !== transfer.currency ? (
        <Text style={styles.rate}>
          {t('transfer.rateAtTime', {
            // The SERVER's own string, interpolated verbatim.
            rate: transfer.transfer_rate,
            counterCurrency: transfer.counter_currency ?? '',
            currency: transfer.currency,
          })}
        </Text>
      ) : null}

      <View style={styles.field}>
        <Text style={styles.label}>{t('common.date')}</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => setShowDatePicker(true)}
          style={styles.dateButton}
        >
          <Text style={styles.dateText}>
            {formatApiDate(occurredAt, { locale })}
          </Text>
        </Pressable>
        {showDatePicker ? (
          <>
            <DateTimePicker
              value={apiDateToLocalDate(occurredAt)}
              mode="date"
              // D-3: the picker follows the UI language, not the device's
              // (see src/components/DateField.tsx for the whole rule).
              locale={locale}
              display={Platform.OS === 'ios' ? 'inline' : 'default'}
              onValueChange={onDateChange}
              onDismiss={() => setShowDatePicker(false)}
            />
            {Platform.OS === 'ios' ? (
              <FormButton
                label={t('common.done')}
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
            label={t('common.noteOptional')}
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

    </Shell>
  );
}

// `footer` is the form's primary actions, pinned above the home-indicator strip
// by KeyboardAwareForm (D-4) instead of scrolling away at the end of the fields.
function Shell({
  title,
  children,
  footer,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const t = useT();

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" onPress={() => router.back()} hitSlop={8}>
          <Text style={styles.cancel}>{t('common.cancel')}</Text>
        </Pressable>
        <Text style={styles.title}>{title}</Text>
        <View style={styles.headerSpacer} />
      </View>
      <KeyboardAwareForm footer={footer}>{children}</KeyboardAwareForm>
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
