import { zodResolver } from '@hookform/resolvers/zod';
import {
  formatApiDate,
  monthBounds,
  multiCurrencyTransactionFormSchema,
  SUPPORTED_CURRENCIES,
  toApiDate,
  toInputString,
  todayApiDate,
  type MultiCurrencyTransactionFormInput,
  type MultiCurrencyTransactionFormValues,
} from '@budget/shared';
import { buildTransactionPatch, emptyToNull } from '@budget/api-client';
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
import { KindSegmented } from '../../src/components/KindSegmented';
import { LabeledInput } from '../../src/components/LabeledInput';
import { colors, spacing, TOUCH_TARGET } from '../../src/components/theme';
import { useAccounts, type AccountRead } from '../../src/data/accounts';
import {
  buildAccountIndex,
  pickDefaultAccount,
  selectableAccounts,
  sortForDisplay as sortAccountsForDisplay,
} from '../../src/data/accountLookup';
import { useCategories } from '../../src/data/categories';
import { sortForDisplay } from '../../src/data/categoryLookup';
import {
  MONTH_LIMIT,
  useCreateTransaction,
  useDeleteTransaction,
  useSummary,
  useTransactions,
  useUpdateTransaction,
} from '../../src/data/transactions';
import { describeTransactionError } from '../../src/data/errors';
import { useLang, useLocale, useT } from '../../src/i18n/context';
import { normalizeAmountInput } from '../../src/lib/amountInput';

type CategoryRead = components['schemas']['CategoryRead'];
type TransactionRead = components['schemas']['TransactionRead'];

// "YYYY-MM-DD" -> a LOCAL Date (component build, no UTC parse — TZ-safe like the
// shared date helpers), for feeding the native picker.
function apiDateToLocalDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export default function TransactionFormScreen() {
  const t = useT();
  const params = useLocalSearchParams<{ id?: string; month?: string }>();
  const month = params.month ?? todayApiDate().slice(0, 7);
  const id = params.id;
  const isEdit = id !== undefined;

  const categoriesQuery = useCategories();
  const summaryQuery = useSummary(month);
  const accountsQuery = useAccounts();

  // Deep-link-safe edit load: locate the row in the already-cached month list by id
  // (same filter slice => same query key => shared cache). No single-row GET exists.
  const bounds = monthBounds(month);
  const txQuery = useTransactions({ from: bounds.from, to: bounds.to, limit: MONTH_LIMIT });
  const cachedTransactions = useMemo(
    () => txQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [txQuery.data],
  );
  const transaction: TransactionRead | undefined = isEdit
    ? cachedTransactions.find((tx) => tx.id === id)
    : undefined;

  const categories = categoriesQuery.data ?? [];

  // accounts-and-transfers MOB: the ACCOUNT decides this row's currency (§4), so
  // the form waits for the account list instead of binding its defaults to an
  // empty one (which is why AccountPicker has no loading arm). Normally a cache
  // hit — the accounts tab and every other form share this one 60s entry.
  if (accountsQuery.isPending) {
    return (
      <Shell title={t(isEdit ? 'txForm.editTitle' : 'txForm.newTitle')}>
        <Text style={styles.notice}>{t('common.loading')}</Text>
      </Shell>
    );
  }

  // Edit mode, list still loading: wait rather than mis-render as create.
  if (isEdit && txQuery.isPending) {
    return (
      <Shell title={t('txForm.editTitle')}>
        <Text style={styles.notice}>{t('common.loading')}</Text>
      </Shell>
    );
  }

  // Cold deep link whose row isn't in the cached month (R4): unavailable + back.
  if (isEdit && transaction === undefined) {
    return (
      <Shell title={t('txForm.editTitle')}>
        <Text accessibilityRole="alert" style={styles.unavailable}>
          {t('txForm.unavailable')}
        </Text>
        <FormButton
          label={t('common.goBack')}
          variant="secondary"
          onPress={() => router.back()}
        />
      </Shell>
    );
  }

  // A transfer is ONE operation with two sides and its own form (A1); this screen
  // has no second account and no second amount, and its kind segment cannot even
  // represent 'transfer'. Only a hand-made deep link gets here (the list routes by
  // kind), so it offers the right door instead of pretending to edit.
  if (transaction?.kind === 'transfer') {
    return (
      <Shell title={t('txForm.editTitle')}>
        <Text style={styles.notice}>{t('txForm.isTransfer')}</Text>
        <FormButton
          label={t('txForm.openTransfer')}
          onPress={() =>
            router.replace({ pathname: '/transfer-form', params: { month, id: transaction.id } })
          }
        />
        <FormButton
          label={t('common.goBack')}
          variant="secondary"
          onPress={() => router.back()}
        />
      </Shell>
    );
  }

  return (
    <TransactionFormBody
      transaction={transaction}
      categories={categories}
      accounts={accountsQuery.data ?? []}
      accountsError={accountsQuery.isError}
      onRetryAccounts={() => accountsQuery.refetch()}
      cachedTransactions={cachedTransactions}
      baseCurrency={summaryQuery.data?.currency}
    />
  );
}

interface BodyProps {
  transaction: TransactionRead | undefined;
  categories: CategoryRead[];
  accounts: AccountRead[];
  accountsError: boolean;
  onRetryAccounts: () => void;
  cachedTransactions: TransactionRead[];
  /**
   * The PROFILE base currency from the month summary, or `undefined` while that
   * query is pending/errored. It is NOT the form's currency any more (the account
   * is — §4) and it is inert here: mobile renders no converted-amount field, so
   * `base_amount` is always the schema's "" AUTO sentinel and no
   * `base_amount_minor` ever goes on the wire.
   */
  baseCurrency: string | undefined;
}

function TransactionFormBody({
  transaction,
  categories,
  accounts,
  accountsError,
  onRetryAccounts,
  cachedTransactions,
  baseCurrency,
}: BodyProps) {
  const t = useT();
  // Formatters follow the INTERFACE language, and the shared error copy is
  // rendered in it too.
  const locale = useLocale();
  const lang = useLang();
  const isEdit = transaction !== undefined;

  const createTransaction = useCreateTransaction();
  const updateTransaction = useUpdateTransaction();
  const deleteTransaction = useDeleteTransaction();
  const [showDatePicker, setShowDatePicker] = useState(false);

  const sortedAccounts = useMemo(
    () => sortAccountsForDisplay(accounts, locale),
    [accounts, locale],
  );
  const accountsById = useMemo(() => buildAccountIndex(accounts), [accounts]);
  // The account of the most recent CACHED operation, else the only usable one,
  // else unpicked (data/accountLookup). Nothing is persisted on the device for
  // this (PM decision on OQ-M1): a cold start with an empty cache simply starts
  // unpicked, which the required-field error then asks the user to fill.
  const defaultAccountId = transaction
    ? transaction.account_id
    : pickDefaultAccount(accounts, cachedTransactions);

  const defaultValues: MultiCurrencyTransactionFormInput = {
    account_id: defaultAccountId,
    amount: transaction ? toInputString(transaction.amount_minor, transaction.currency) : '',
    // NOT a wire value: the create body sends NO currency (the server stamps it
    // from the account, §4) and the patch builder emits it only as the echo of an
    // account change. It IS the exponent the amount is parsed with, so it is
    // rewritten the moment another account is picked. The last fallback stands
    // only while nothing is picked — a state in which the form cannot submit at
    // all, because `account_id` is required.
    currency:
      transaction?.currency ??
      accountsById.get(defaultAccountId)?.currency ??
      baseCurrency ??
      SUPPORTED_CURRENCIES[0],
    // Mobile renders no converted-amount section: "" is the schema's AUTO
    // sentinel, so the server owns the base snapshot on every write from here.
    base_amount: '',
    // A transfer never reaches this form (the screen sends it to its own), so the
    // narrow is a fact, not a fallback.
    kind: transaction?.kind === 'income' ? 'income' : 'expense',
    category_id: transaction?.category_id ?? '',
    occurred_at: transaction?.occurred_at ?? todayApiDate(),
    note: transaction?.note ?? '',
  };

  // Output-shaped initial values for the PATCH diff (amount as parsed minor units).
  const initial: MultiCurrencyTransactionFormValues = {
    account_id: transaction?.account_id ?? defaultAccountId,
    amount: transaction?.amount_minor ?? 0,
    // Diff BASELINE, not a decode fallback: the create branch never reaches the
    // patch builder at all.
    currency: defaultValues.currency,
    // Mirrors what the (absent) field shows — AUTO on both sides, so the diff is
    // "unchanged" and no `base_amount_minor` key is ever emitted from mobile. A
    // stored override set on the web therefore survives an edit made here.
    base_amount_minor: null,
    kind: defaultValues.kind,
    category_id: transaction?.category_id ?? '',
    occurred_at: transaction?.occurred_at ?? '',
    note: transaction?.note ?? '',
    merchant: transaction?.merchant ?? '',
  };

  // F-1: the decimal-pad's separator key is the DEVICE locale's (',' on ru-RU), while
  // the shared schema's parseMoney accepts '.' only. Normalize at this boundary — the
  // field keeps displaying what the user typed, only what is validated/submitted is
  // normalized. Ambiguous multi-separator input passes through and is still rejected.
  //
  // The resolver no longer depends on the selected currency: the amount's exponent
  // follows the in-form `currency` value INSIDE the shared schema, and that value
  // is restamped by the account picker — so switching accounts re-evaluates the
  // amount at the new account's exponent with no resolver identity change.
  const resolver: Resolver<
    MultiCurrencyTransactionFormInput,
    unknown,
    MultiCurrencyTransactionFormValues
  > = (values, context, options) =>
    zodResolver(multiCurrencyTransactionFormSchema(baseCurrency ?? values.currency))(
      { ...values, amount: normalizeAmountInput(values.amount) },
      context,
      options,
    );

  const {
    control,
    handleSubmit,
    setError,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<
    MultiCurrencyTransactionFormInput,
    unknown,
    MultiCurrencyTransactionFormValues
  >({
    resolver,
    defaultValues,
  });

  const kind = useWatch({ control, name: 'kind' });
  const selectedCategoryId = useWatch({ control, name: 'category_id' });
  const selectedAccountId = useWatch({ control, name: 'account_id' });
  const currency = useWatch({ control, name: 'currency' });
  const occurredAt = useWatch({ control, name: 'occurred_at' });

  // Picking another ACCOUNT is a currency change (§4: the row is denominated in
  // its account's currency), so it restamps the form's currency — the exponent the
  // amount is read with. An unknown id cannot come from this picker; leaving the
  // currency alone is the honest no-op (never a guessed exponent).
  const onAccountChange = (accountId: string) => {
    setValue('account_id', accountId);
    const picked = accountsById.get(accountId);
    if (picked) setValue('currency', picked.currency);
  };

  // The picker shows the SELECTED KIND's categories (kind-segmented). An edit whose
  // saved category is archived keeps it selectable as the current value.
  const nonArchived = categories.filter((category) => !category.archived);
  const currentCategory = transaction?.category_id
    ? categories.find((category) => category.id === transaction.category_id)
    : undefined;
  const options = currentCategory?.archived ? [...nonArchived, currentCategory] : nonArchived;
  const kindOptions = sortForDisplay(options, locale).filter(
    (category) => category.kind === kind,
  );

  const onKindChange = (next: 'expense' | 'income') => {
    setValue('kind', next);
    // Flipping the segment clears a selected category whose kind no longer matches.
    const selected = categories.find((category) => category.id === selectedCategoryId);
    if (selected && selected.kind !== next) setValue('category_id', '');
  };

  const onPickCategory = (category: CategoryRead) => {
    setValue('category_id', category.id);
    // Picking a category sets kind by direct assignment (W5).
    setValue('kind', category.kind);
  };

  // F-3: `onChange` is deprecated in @react-native-community/datetimepicker 9.x
  // (it warns on every open). onValueChange/onDismiss are the same two branches the
  // event-type switch encoded: Android closes the dialog either way, iOS keeps the
  // inline picker up until "Done".
  const onDateChange = (_event: DateTimePickerChangeEvent, date: Date) => {
    if (Platform.OS !== 'ios') setShowDatePicker(false);
    setValue('occurred_at', toApiDate(date));
  };

  const routeError = (error: unknown) => {
    const { field, message } = describeTransactionError(error, lang);
    // The two counter_* fields belong to the transfer form; a 422 naming one of
    // them here has no control to land on, so it stays at form level.
    const target =
      field === 'form' ||
      field === 'counter_account_id' ||
      field === 'counter_amount_minor'
        ? 'root'
        : field === 'amount_minor'
          ? 'amount'
          : field;
    setError(target, { message });
  };

  const onSubmit = handleSubmit(async (values) => {
    try {
      if (isEdit && transaction) {
        // 3-arg (multi-currency) form: it emits `account_id` and its paired
        // `currency` echo when the account changed. `base_amount_minor` is
        // unchanged on both sides here, so no such key is ever produced.
        const patch = buildTransactionPatch(values, initial, baseCurrency ?? values.currency);
        if (Object.keys(patch).length > 0) {
          await updateTransaction.mutateAsync({
            id: transaction.id,
            body: patch,
            previousOccurredAt: transaction.occurred_at,
          });
        }
      } else {
        await createTransaction.mutateAsync({
          account_id: values.account_id,
          amount_minor: values.amount,
          kind: values.kind,
          category_id: emptyToNull(values.category_id),
          occurred_at: values.occurred_at,
          note: emptyToNull(values.note),
          // No `currency`: the server stamps it from the account (§4), and a
          // client copy could only ever agree (redundant) or disagree (422).
        });
      }
      router.back();
    } catch (error) {
      routeError(error);
    }
  });

  const onDelete = () => {
    if (!transaction) return;
    confirmAction({
      title: t('txForm.deleteTitle'),
      message: t('txForm.deleteMessage'),
      confirmLabel: t('common.delete'),
      destructive: true,
      onConfirm: () => {
        deleteTransaction.mutate(
          { id: transaction.id, occurredAt: transaction.occurred_at },
          {
            onSuccess: () => router.back(),
            onError: routeError,
          },
        );
      },
    });
  };

  const pending = isSubmitting || createTransaction.isPending || updateTransaction.isPending;
  // `account_id` is required server-side, so with no account to offer there is
  // nothing valid to submit — the picker says why, this only answers the button's
  // question. An unreachable account list blocks Save for the same reason.
  const blocked =
    accountsError || selectableAccounts(accounts, transaction?.account_id).length === 0;

  return (
    <Shell title={t(isEdit ? 'txForm.editTitle' : 'txForm.newTitle')}>
      <FieldError message={errors.root?.message} />

      <AccountPicker
        label={t('txForm.account')}
        accounts={sortedAccounts}
        isError={accountsError}
        onRetry={onRetryAccounts}
        value={selectedAccountId}
        onChange={onAccountChange}
        currentId={transaction?.account_id}
        error={errors.account_id?.message}
      />

      <Controller
        control={control}
        name="amount"
        render={({ field }) => (
          <LabeledInput
            // The currency is the SELECTED ACCOUNT's; with nothing picked yet the
            // label names none, because the placeholder exponent standing in the
            // form state is not a promise about how this row will be stored.
            label={
              selectedAccountId === ''
                ? t('common.amount')
                : t('txForm.amountIn', { currency })
            }
            keyboardType="decimal-pad"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={errors.amount?.message}
          />
        )}
      />

      <View style={styles.field}>
        <Text style={styles.label}>{t('common.type')}</Text>
        <KindSegmented value={kind} onChange={onKindChange} />
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>{t('txForm.category')}</Text>
        <View style={styles.chips}>
          <Chip
            label={t('common.uncategorized')}
            selected={selectedCategoryId === ''}
            onPress={() => setValue('category_id', '')}
          />
          {kindOptions.map((category) => (
            <Chip
              key={category.id}
              label={`${category.icon ? `${category.icon} ` : ''}${category.name}${
                category.archived ? ` ${t('common.archivedParens')}` : ''
              }`}
              selected={selectedCategoryId === category.id}
              onPress={() => onPickCategory(category)}
            />
          ))}
        </View>
        <FieldError message={errors.category_id?.message} />
      </View>

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
    </Shell>
  );
}

function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.chip, selected && styles.chipSelected]}
    >
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
    </Pressable>
  );
}

function Shell({ title, children }: { title: string; children: ReactNode }) {
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
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  chip: {
    minHeight: TOUCH_TARGET - 8,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    justifyContent: 'center',
  },
  chipSelected: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  chipText: {
    fontSize: 14,
    color: colors.text,
  },
  chipTextSelected: {
    color: '#FFFFFF',
    fontWeight: '600',
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
