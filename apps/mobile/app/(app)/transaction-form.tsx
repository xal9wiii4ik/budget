import { zodResolver } from '@hookform/resolvers/zod';
import {
  countryToCurrency,
  formatApiDate,
  formatMoney,
  isPairMode,
  migrateAmounts,
  monthBounds,
  multiCurrencyTransactionFormSchema,
  spendCurrencyOptions,
  spendPrefill,
  SUPPORTED_CURRENCIES,
  toApiDate,
  todayApiDate,
  type MultiCurrencyTransactionFormInput,
  type MultiCurrencyTransactionFormValues,
} from '@budget/shared';
import {
  ApiError,
  buildCreateBody,
  buildTransactionPatch,
  // --- goals (catch-up 3, line C): the pure rules, shared with web ---
  goalItemSelectionForKind,
  NO_GOAL_ITEM,
  showsGoalItemField,
  type GoalItemSelection,
  emptyToNull,
  getErrorCode,
} from '@budget/api-client';
import type { components } from '@budget/api-client';
import DateTimePicker, {
  type DateTimePickerChangeEvent,
} from '@react-native-community/datetimepicker';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState, type ReactNode } from 'react';
import { Controller, useForm, useWatch, type Resolver } from 'react-hook-form';
import { Platform, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AccountPicker } from '../../src/components/AccountPicker';
import { confirmAction } from '../../src/components/confirm';
import { FieldError } from '../../src/components/FieldError';
import { FormButton } from '../../src/components/FormButton';
import { KeyboardAwareForm } from '../../src/components/KeyboardAwareForm';
import { KindSegmented } from '../../src/components/KindSegmented';
import { LabeledInput } from '../../src/components/LabeledInput';
import { themedStyles } from '../../src/theme/themedStyles';
import { useTheme } from '../../src/theme/useTheme';
import { useAccounts, type AccountRead } from '../../src/data/accounts';
import {
  buildAccountIndex,
  pickDefaultAccount,
  selectableAccounts,
  sortForDisplay as sortAccountsForDisplay,
} from '../../src/data/accountLookup';
import { useCategories } from '../../src/data/categories';
import { sortForDisplay } from '../../src/data/categoryLookup';
import { useFxPreview } from '../../src/data/fx';
import { useProfile } from '../../src/data/profile';
import {
  MONTH_LIMIT,
  useCreateTransaction,
  useDeleteTransaction,
  useSummary,
  useTransactions,
  useUpdateTransaction,
} from '../../src/data/transactions';
import { describeTransactionError } from '../../src/data/errors';
import { AttachPhotoField } from '../../src/features/transactions/AttachPhotoField';
// --- goals (catch-up 3, line C) ---
import { GoalItemPicker } from '../../src/features/transactions/GoalItemPicker';
import { chargePreviewRequest } from '../../src/features/transactions/chargePreview';
import { CountryField } from '../../src/features/transactions/CountryField';
import { KIND_COPY } from '../../src/features/transactions/kindCopy';
import { describeOriginalPairError } from '../../src/features/transactions/originalPairError';
import { SpendCurrencyPicker } from '../../src/features/transactions/SpendCurrencyPicker';
import { useLang, useLocale, useT } from '../../src/i18n/context';
import { localizeAmountString, normalizeAmountInput } from '../../src/lib/amountInput';
import { useDebouncedValue } from '../../src/lib/useDebouncedValue';

type CategoryRead = components['schemas']['CategoryRead'];
type TransactionRead = components['schemas']['TransactionRead'];

// A rate estimate per keystroke would be pure waste — rates are daily rows.
const PREVIEW_DEBOUNCE_MS = 300;

// "YYYY-MM-DD" -> a LOCAL Date (component build, no UTC parse — TZ-safe like the
// shared date helpers), for feeding the native picker.
function apiDateToLocalDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export default function TransactionFormScreen() {
  const t = useT();
  const styles = useStyles();
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
  const styles = useStyles();
  const { scheme } = useTheme();
  // Formatters follow the INTERFACE language, and the shared error copy is
  // rendered in it too.
  const locale = useLocale();
  const lang = useLang();
  const isEdit = transaction !== undefined;

  const createTransaction = useCreateTransaction();
  const updateTransaction = useUpdateTransaction();
  const deleteTransaction = useDeleteTransaction();
  const [showDatePicker, setShowDatePicker] = useState(false);

  // The profile: the country a NEW operation starts in, and through it the
  // currency the spend-currency picker suggests first. It never blocks the form —
  // the app already fetched it for the interface language, and a profile that has
  // not arrived simply contributes no default (an invented country would be
  // written to a real row).
  const profile = useProfile();
  const profileCountry = profile.data?.country ?? null;

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

  // NOT a wire value: the create body sends NO currency (the server stamps it
  // from the account, §4) and the patch builder emits it only as the echo of an
  // account change. It IS the exponent the charged amount is parsed with, so it
  // is rewritten the moment another account is picked. The last fallback stands
  // only while nothing is picked — a state in which the form cannot submit at
  // all, because `account_id` is required.
  const startingCurrency =
    transaction?.currency ??
    accountsById.get(defaultAccountId)?.currency ??
    baseCurrency ??
    SUPPORTED_CURRENCIES[0];

  // Edit prefill of the two amounts, each decoded with the currency IT is
  // denominated in (@budget/shared, AM-5). On create there is one amount and the
  // spend currency starts equal to the account's — which IS "no pair".
  const spend = transaction ? spendPrefill(transaction) : null;

  const defaultValues: MultiCurrencyTransactionFormInput = {
    account_id: defaultAccountId,
    // N-5 (catch-up 3, line B): `spendPrefill` answers MACHINE strings ('.' —
    // the shared money contract), and a ru decimal-pad has no '.' key, so the
    // prefill is rewritten with the separator the interface language types. The
    // resolver's `normalizeAmountInput` maps it straight back.
    amount: spend ? localizeAmountString(spend.amount, lang) : '',
    currency: startingCurrency,
    // S1: the currency the money was SPENT in. Equal to the account's means "one
    // amount, no pair" — deliberately NOT the profile country's currency: most
    // operations are in the account's own currency, and the country only orders
    // the suggestions.
    original_currency: spend ? spend.spendCurrency : startingCurrency,
    original_amount: spend ? localizeAmountString(spend.originalAmount, lang) : '',
    // S2: a new operation starts in the profile's country. Read at MOUNT, like
    // every other default — a profile that arrives later does not retro-fill a
    // form the user is already typing in (web behaves the same way).
    country: transaction ? (transaction.country ?? '') : (profileCountry ?? ''),
    merchant: transaction?.merchant ?? '',
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

  // Output-shaped initial values for the PATCH diff (amounts as parsed minor units).
  const initial: MultiCurrencyTransactionFormValues = {
    account_id: transaction?.account_id ?? defaultAccountId,
    amount: transaction?.amount_minor ?? 0,
    // Diff BASELINE, not a decode fallback: the create branch never reaches the
    // patch builder at all.
    currency: startingCurrency,
    // Mirrors what the (absent) field shows — AUTO on both sides, so the diff is
    // "unchanged" and no `base_amount_minor` key is ever emitted from mobile. A
    // stored override set on the web therefore survives an edit made here.
    base_amount_minor: null,
    kind: defaultValues.kind,
    category_id: transaction?.category_id ?? '',
    occurred_at: transaction?.occurred_at ?? '',
    note: transaction?.note ?? '',
    // The BASELINE of the merchant diff, which this form now owns explicitly:
    // `buildTransactionPatch` deliberately emits no merchant key at all.
    merchant: transaction?.merchant ?? '',
    // S1/S2: the stored pair and country as they are, so an untouched form sends
    // neither. `?? null` is the ABSENCE of a pair, never a decode fallback.
    original_amount_minor: transaction?.original_amount_minor ?? null,
    original_currency: transaction?.original_currency ?? null,
    country: transaction?.country ?? '',
  };

  // F-1: the decimal-pad's separator key is the DEVICE locale's (',' on ru-RU), while
  // the shared schema's parseMoney accepts '.' only. Normalize at this boundary — the
  // fields keep displaying what the user typed, only what is validated/submitted is
  // normalized. Ambiguous multi-separator input passes through and is still rejected.
  // BOTH money fields go through it: the spent amount is typed on the same keypad.
  //
  // The resolver does not depend on the SELECTED currency: each amount's exponent
  // follows the in-form currency it is denominated in INSIDE the shared schema.
  const resolver: Resolver<
    MultiCurrencyTransactionFormInput,
    unknown,
    MultiCurrencyTransactionFormValues
  > = (values, context, options) =>
    zodResolver(multiCurrencyTransactionFormSchema(baseCurrency ?? values.currency))(
      {
        ...values,
        amount: normalizeAmountInput(values.amount),
        original_amount:
          values.original_amount === undefined
            ? undefined
            : normalizeAmountInput(values.original_amount),
      },
      context,
      options,
    );

  const {
    control,
    handleSubmit,
    getValues,
    setError,
    setValue,
    formState: { errors, dirtyFields, isSubmitting },
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
  const amountRaw = useWatch({ control, name: 'amount' });
  const spentRaw = useWatch({ control, name: 'original_amount' }) ?? '';
  const country = useWatch({ control, name: 'country' }) ?? '';
  const spendCurrency = useWatch({ control, name: 'original_currency' }) ?? currency;

  // Every direction-dependent label in this form, looked up from the WATCHED kind
  // during render (features/transactions/kindCopy.ts). No effect and no second
  // copy of the kind in state: flipping the segment re-renders and the words
  // follow. This is also why the kind segment is the FIRST control on screen.
  const copy = KIND_COPY[kind];

  const pairMode = isPairMode(spendCurrency, currency);
  const spendOptions = spendCurrencyOptions({
    accountCurrency: currency,
    profileCurrency: countryToCurrency(profileCountry),
    accountCurrencies: accounts.map((account) => account.currency),
    current: spendCurrency,
  });

  // The photo this operation is linked to. CLIENT state, not server state: until
  // Save it is an unsaved edit of the row, exactly like a typed note.
  const initialReceiptId = transaction?.receipt_id ?? null;
  const [receiptId, setReceiptId] = useState<string | null>(initialReceiptId);

  // --- goals (catch-up 3, line C) -------------------------------------------
  // Which plan item this operation pays for. CLIENT state, not server state:
  // until Save it is an unsaved edit of the row, exactly like a typed note. The
  // `goalId` member is UI-only — it decides which tree to fetch and is never
  // sent; the wire carries `goal_item_id` alone.
  const initialGoalItemId = transaction?.goal_item_id ?? null;
  const [goalItem, setGoalItem] = useState<GoalItemSelection>(
    initialGoalItemId === null ? NO_GOAL_ITEM : { goalId: '', itemId: initialGoalItemId },
  );
  // A 422 about the attachment has no react-hook-form field to land on (the
  // picker is not a form control), so it is held here and rendered by the picker.
  const [goalItemError, setGoalItemError] = useState<string | undefined>(undefined);

  // The server told us it has no rate for this exact lookup (422
  // FX_RATE_UNAVAILABLE — normal for a pair outside the six canonical ones). The
  // three inputs of that lookup are REMEMBERED with it, so the state clears
  // itself the moment any of them changes: derived during render, never synced by
  // an effect that could leave a stale warning on screen.
  const [rateGap, setRateGap] = useState<{ from: string; to: string; date: string } | null>(
    null,
  );
  const manualCharge =
    rateGap !== null &&
    rateGap.from === spendCurrency &&
    rateGap.to === currency &&
    rateGap.date === occurredAt;

  // An ESTIMATE of what the account will be charged, for a create where the user
  // left the charge to the server. TEXT ONLY — it is never written into the field
  // (the client does not multiply by rates, D8; the server computes the stored
  // value at save time). Its real job is telling the user BEFORE they save that
  // this currency pair has no rate, instead of after a 422. The decision of
  // whether to ask at all — including "never while the charged field has
  // something in it" — is the pure `chargePreviewRequest`.
  const debouncedSpent = useDebouncedValue(spentRaw, PREVIEW_DEBOUNCE_MS);
  const debouncedDate = useDebouncedValue(occurredAt, PREVIEW_DEBOUNCE_MS);
  const chargeParams = chargePreviewRequest({
    isEdit,
    pairMode,
    chargedRaw: amountRaw,
    spentNormalized: normalizeAmountInput(debouncedSpent),
    spendCurrency,
    accountCurrency: currency,
    date: debouncedDate,
  });
  const chargePreview = useFxPreview(chargeParams);

  // Picking another ACCOUNT is a currency change (§4: the row is denominated in
  // its account's currency), so it restamps the form's currency — the exponent the
  // charged amount is read with. An unknown id cannot come from this picker;
  // leaving the currency alone is the honest no-op (never a guessed exponent).
  const onAccountChange = (accountId: string) => {
    setValue('account_id', accountId, { shouldDirty: true });
    const picked = accountsById.get(accountId);
    if (!picked) return;
    setValue('currency', picked.currency, { shouldDirty: true });
    // An operation with ONE amount keeps having one — the spend currency follows
    // the account. A pair keeps the currency the money was spent in; if the new
    // account happens to be held in that very currency the pair collapses instead
    // of colliding with the server's ORIGINAL_CURRENCY_MATCHES_ACCOUNT rule.
    const nextSpend = pairMode ? spendCurrency : picked.currency;
    setValue('original_currency', nextSpend, { shouldDirty: true });
    moveAmounts(pairMode, isPairMode(nextSpend, picked.currency));
  };

  // S1: picking the currency the money was SPENT in. The two amount fields move
  // with the mode — see `migrateAmounts` (@budget/shared) for why the visible
  // number stays where the user is looking. The strings moved are the RAW typed
  // ones (F-1): normalization happens in the resolver, not here.
  const onSpendCurrencyChange = (code: string) => {
    setValue('original_currency', code, { shouldDirty: true, shouldValidate: false });
    moveAmounts(pairMode, isPairMode(code, currency));
  };

  function moveAmounts(wasPair: boolean, isPair: boolean): void {
    const migrated = migrateAmounts(
      { amount: getValues('amount'), originalAmount: getValues('original_amount') ?? '' },
      wasPair,
      isPair,
    );
    setValue('amount', migrated.amount, { shouldDirty: true, shouldValidate: false });
    setValue('original_amount', migrated.originalAmount, {
      shouldDirty: true,
      shouldValidate: false,
    });
  }

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
    // catch-up 3, line C: the server accepts an attachment on EXPENSES only, so
    // income drops it — exactly like the category above. Keeping it in hidden
    // state is how a form ends up submitting a body the server is guaranteed to
    // refuse, about a field the user cannot see. The pure rule is shared with
    // web (@budget/api-client `goalItemSelectionForKind`).
    setGoalItem((previous) => goalItemSelectionForKind(previous, next));
  };

  const onPickCategory = (category: CategoryRead) => {
    setValue('category_id', category.id);
    // Picking a category sets kind by direct assignment (W5).
    setValue('kind', category.kind);
    // catch-up 3, line C: this is the OTHER way the kind flips, so it clears the
    // attachment for the same reason.
    setGoalItem((previous) => goalItemSelectionForKind(previous, category.kind));
  };

  // F-3: `onChange` is deprecated in @react-native-community/datetimepicker 9.x
  // (it warns on every open). onValueChange/onDismiss are the same two branches the
  // event-type switch encoded: Android closes the dialog either way, iOS keeps the
  // inline picker up until "Done".
  const onDateChange = (_event: DateTimePickerChangeEvent, date: Date) => {
    if (Platform.OS !== 'ios') setShowDatePicker(false);
    setValue('occurred_at', toApiDate(date));
  };

  // What the CHARGED field promises while it sits empty. Four honest arms, in the
  // order the user meets them: the server has said it cannot convert this pair;
  // an edit whose spent amount moved; a live estimate; and the plain default.
  // Every one of them is TEXT — none of them fills the field.
  const chargeHints: string[] = [];
  if (pairMode) {
    if (manualCharge) {
      chargeHints.push(t(copy.chargeManual, { from: spendCurrency, to: currency }));
    } else if (isEdit) {
      if ((dirtyFields.original_amount || dirtyFields.original_currency) && !dirtyFields.amount) {
        // PATCH row 4: the pair travels without amount_minor, so the server
        // recomputes the charge. Saying so beats a number silently changing.
        chargeHints.push(
          t('txForm.chargeRecalcDated', { date: formatApiDate(occurredAt, { locale }) }),
        );
      }
    } else if (chargeParams !== null) {
      const charge = chargePreview.data;
      if (chargePreview.isPending) {
        chargeHints.push(t('txForm.converting'));
      } else if (chargePreview.isError) {
        chargeHints.push(t('txForm.chargeFetchFailed', { currency }));
      } else if (charge) {
        if (charge.converted_minor === null || charge.rate === null) {
          // The normal answer for a pair outside the six canonical ones — said
          // here, before the save, instead of as a 422 afterwards.
          chargeHints.push(t(copy.chargeNoRateAhead, { from: spendCurrency, to: currency }));
        } else {
          // `rate` is the SERVER's own decimal string, printed verbatim; the
          // converted amount is decoded with the currency the server echoed.
          chargeHints.push(
            t('txForm.chargeEstimate', {
              amount: formatMoney(charge.converted_minor, charge.to, { locale }),
              rate: charge.rate,
            }),
          );
        }
      }
    }
    if (chargeHints.length === 0) {
      chargeHints.push(t(copy.chargeDefault));
    }
  }

  const routeError = (error: unknown) => {
    // The codes this form's two-amount model owns, before the shared layer sees
    // them. FX_RATE_UNAVAILABLE is the important one and it is NOT a failure —
    // only six canonical pairs have stored rates, so for anything exotic the
    // answer is "tell us what your bank charged", and the form switches into that
    // mode instead of showing an error the user cannot act on.
    const own = describeOriginalPairError(
      error instanceof ApiError ? getErrorCode(error.body) : undefined,
    );
    if (own) {
      if (own.needsManualCharge) {
        setRateGap({ from: spendCurrency, to: currency, date: getValues('occurred_at') });
      }
      setError(own.target === 'form' ? 'root' : own.target, {
        // The pure module names a KEY, or a ROLE when the sentence depends on the
        // direction; either way the sentence is chosen here, in whatever language
        // and for whichever kind is on screen.
        message: t(own.message.kind === 'key' ? own.message.key : copy[own.message.role], {
          from: spendCurrency,
          to: currency,
        }),
      });
      return;
    }
    const { field, message } = describeTransactionError(error, lang);
    // catch-up 3, line C: the picker is not a form control, so its message is
    // held beside the form rather than in it.
    if (field === 'goal_item_id') {
      setGoalItemError(message);
      return;
    }
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
    // The server has already told us it cannot convert this pair on this date
    // (see `manualCharge`): asking it again would only repeat the same 422, so
    // the ask lands on the field instead of on the network.
    if (pairMode && manualCharge && values.amount === null) {
      setError('amount', { message: t(copy.manualChargeRequired, { currency }) });
      return;
    }
    try {
      if (isEdit && transaction) {
        // The 3-arg (multi-currency) builder: it emits `account_id` with its
        // paired `currency` echo, the original pair ATOMICALLY, and `country`.
        // `base_amount_minor` is unchanged on both sides here, so no such key is
        // ever produced from this screen.
        const patch = buildTransactionPatch(values, initial, baseCurrency ?? values.currency);
        // `merchant` is diffed HERE, not in the shared builder: that builder must
        // keep emitting no merchant key at all (patch.test.ts pins it), so every
        // form that renders the input owns the trichotomy itself — unchanged ->
        // omit, "" -> null.
        if (values.merchant !== initial.merchant) {
          patch.merchant = emptyToNull(values.merchant);
        }
        // Attach / replace / detach, same trichotomy. Detaching removes the LINK
        // only — no delete endpoint is called, and none exists.
        if (receiptId !== initialReceiptId) patch.receipt_id = receiptId;
        // catch-up 3, line C: the attachment is diffed HERE for the same reason
        // as `merchant` — the shared builder emits no such key. Unchanged ->
        // omit, cleared -> explicit null (detach).
        const nextGoalItemId = goalItem.itemId === '' ? null : goalItem.itemId;
        if (nextGoalItemId !== initialGoalItemId) patch.goal_item_id = nextGoalItemId;
        if (Object.keys(patch).length > 0) {
          await updateTransaction.mutateAsync({
            id: transaction.id,
            body: patch,
            previousOccurredAt: transaction.occurred_at,
            // catch-up 3, line C: where the operation WAS attached. The response
            // only says where it is now, so a detach or a move would otherwise
            // leave the old node's `paid` rollup stale.
            previousGoalItemId: initialGoalItemId,
          });
        }
      } else {
        // `baseAmountEdited` is FALSE for good: mobile renders no converted-to-
        // base field, so it never claims a user override of the base snapshot.
        const body = buildCreateBody(values, baseCurrency ?? values.currency, false);
        // The name of the operation, on EVERY create: it is what titles the row
        // in the list, and what the server learns the merchant->category mapping
        // from. Same ""->null bridge as `note`.
        body.merchant = emptyToNull(values.merchant);
        if (receiptId !== null) body.receipt_id = receiptId;
        // catch-up 3, line C. Expense-only by construction: the picker is not
        // rendered for income and the selection is cleared when the kind flips.
        if (goalItem.itemId !== '') body.goal_item_id = goalItem.itemId;
        await createTransaction.mutateAsync(body);
      }
      router.back();
    } catch (error) {
      routeError(error);
    }
  });

  const onDelete = () => {
    if (!transaction) return;
    confirmAction({
      cancelLabel: t('common.cancel'),
      title: t('txForm.deleteTitle'),
      message: t('txForm.deleteMessage'),
      confirmLabel: t('common.delete'),
      destructive: true,
      onConfirm: () => {
        deleteTransaction.mutate(
          // catch-up 3, line C: nothing can be attached to a row that is gone,
          // but the node it WAS on still has to be refreshed.
          {
            id: transaction.id,
            occurredAt: transaction.occurred_at,
            previousGoalItemId: initialGoalItemId,
          },
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
    <Shell
      title={t(isEdit ? 'txForm.editTitle' : 'txForm.newTitle')}
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

      {/* The kind comes FIRST: every label below is worded by direction, so the
          form has to know which way the money went before anything is filled in. */}
      <View style={styles.field}>
        <Text style={styles.label}>{t('common.type')}</Text>
        <KindSegmented value={kind} onChange={onKindChange} />
      </View>

      <AccountPicker
        label={t(copy.account)}
        accounts={sortedAccounts}
        isError={accountsError}
        onRetry={onRetryAccounts}
        value={selectedAccountId}
        onChange={onAccountChange}
        currentId={transaction?.account_id}
        error={errors.account_id?.message}
      />

      {/* The leading amount slot: `original_amount` in pair mode, `amount`
          otherwise, because to the user it is the same field ("how much was it,
          in what currency"). What happens to the number when the mode flips is
          `migrateAmounts`, not this JSX. */}
      {pairMode ? (
        <Controller
          control={control}
          name="original_amount"
          render={({ field }) => (
            <LabeledInput
              label={t(copy.spentLabel, { currency: spendCurrency })}
              keyboardType="decimal-pad"
              value={field.value ?? ''}
              onChangeText={field.onChange}
              onBlur={field.onBlur}
              error={errors.original_amount?.message}
            />
          )}
        />
      ) : (
        <Controller
          control={control}
          name="amount"
          render={({ field }) => (
            <LabeledInput
              // With nothing picked yet the label names no currency, because the
              // placeholder exponent standing in the form state is not a promise
              // about how this row will be stored.
              label={
                selectedAccountId === ''
                  ? t('common.amount')
                  : t(copy.amountLabel, { currency })
              }
              keyboardType="decimal-pad"
              value={field.value}
              onChangeText={field.onChange}
              onBlur={field.onBlur}
              error={errors.amount?.message}
            />
          )}
        />
      )}

      {/* Its own VISIBLE label, not just an accessibility one: a bare code next
          to the amount reads as decoration, and "I thought the currency could not
          be changed" was the actual complaint. */}
      <View style={styles.field}>
        <Text style={styles.label}>{t(copy.spendCurrencyLabel)}</Text>
        <SpendCurrencyPicker
          value={spendCurrency}
          suggestions={spendOptions}
          onChange={onSpendCurrencyChange}
          otherLabel={t('txForm.spendCurrencyOtherLabel')}
        />
        {!pairMode ? <Text style={styles.hint}>{t(copy.spendCurrencyHint)}</Text> : null}
        <FieldError message={errors.original_currency?.message} />
        <FieldError message={errors.currency?.message} />
      </View>

      {/* What the ACCOUNT was charged — the number that hits the balance.
          Optional: empty means "convert what I spent at that day's rate", and the
          server does that arithmetic, never this client (D8). */}
      {pairMode ? (
        <Controller
          control={control}
          name="amount"
          render={({ field }) => (
            <LabeledInput
              label={
                manualCharge
                  ? t(copy.chargedLabel, { currency })
                  : `${t(copy.chargedLabel, { currency })} ${t('common.optional')}`
              }
              keyboardType="decimal-pad"
              value={field.value}
              onChangeText={field.onChange}
              onBlur={field.onBlur}
              hint={chargeHints.join(' ')}
              error={errors.amount?.message}
            />
          )}
        />
      ) : null}

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
              // D-3: the picker follows the UI language, not the device's
              // (see src/components/DateField.tsx for the whole rule).
              locale={locale}
              display={Platform.OS === 'ios' ? 'inline' : 'default'}
              // iOS-only: without it the inline picker stays light in a dark UI.
              themeVariant={scheme}
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

      {/* The operation's NAME — the same `merchant` column the receipt flow fills
          in, so there is no second field for the same fact. "Groceries" three
          times in a list tells nobody which shop that was. */}
      <Controller
        control={control}
        name="merchant"
        render={({ field }) => (
          <LabeledInput
            label={`${t(copy.merchantLabel)} ${t('common.optional')}`}
            maxLength={255}
            value={field.value ?? ''}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            hint={copy.merchantHint ? t(copy.merchantHint) : undefined}
            error={errors.merchant?.message}
          />
        )}
      />

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

      {/* Attaching a photo is NOT scanning it: this control uploads and links,
          and never calls the parser, so it works with no AI key at all. */}
      <AttachPhotoField receiptId={receiptId} onChange={setReceiptId} disabled={pending} />

      {/* --- goals (catch-up 3, line C) ---
          Only an expense can pay for a plan item (the server refuses anything
          else), so the control is not rendered for income — and the selection is
          CLEARED there too, in the kind handlers above, rather than kept in
          hidden state. */}
      {showsGoalItemField(kind) ? (
        <GoalItemPicker
          value={goalItem}
          onChange={(next) => {
            setGoalItemError(undefined);
            setGoalItem(next);
          }}
          initialItemId={initialGoalItemId}
          disabled={pending}
          errorMessage={goalItemError}
        />
      ) : null}

      {/* Folded away, like web's <details>: the country is a detail of a minority
          of rows, and the user asked for it not to crowd the form. */}
      <CountryField
        value={country}
        onChange={(code) => setValue('country', code, { shouldDirty: true })}
        initialValue={transaction?.country ?? null}
        profileCountry={profileCountry}
        error={errors.country?.message}
      />
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
  const styles = useStyles();
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
  const styles = useStyles();

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

const useStyles = themedStyles((t) => ({
  safe: {
    flex: 1,
    backgroundColor: t.colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: t.spacing.lg,
    paddingVertical: t.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: t.colors.border,
    backgroundColor: t.colors.surface,
  },
  title: {
    fontSize: t.type.lg,
    fontWeight: '700',
    color: t.colors.text,
  },
  cancel: {
    fontSize: t.type.md,
    color: t.colors.accent,
    minWidth: 60,
  },
  headerSpacer: {
    minWidth: 60,
  },
  field: {
    gap: t.spacing.xs,
  },
  label: {
    fontSize: t.type.sm,
    fontWeight: '600',
    color: t.colors.text,
  },
  notice: {
    color: t.colors.textMuted,
    fontSize: t.type.sm,
  },
  unavailable: {
    color: t.colors.danger,
    fontSize: t.type.md,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: t.spacing.sm,
  },
  chip: {
    minHeight: t.TOUCH_TARGET - 8,
    paddingHorizontal: t.spacing.md,
    paddingVertical: t.spacing.sm,
    borderRadius: t.radius.full,
    borderWidth: 1,
    borderColor: t.colors.border,
    backgroundColor: t.colors.surface,
    justifyContent: 'center',
  },
  chipSelected: t.selected.chip,
  chipText: {
    fontSize: t.type.sm,
    color: t.colors.text,
  },
  chipTextSelected: t.selected.text,
  dateButton: {
    minHeight: t.TOUCH_TARGET,
    borderWidth: 1,
    borderColor: t.colors.borderStrong,
    borderRadius: t.radius.md,
    paddingHorizontal: t.spacing.md,
    justifyContent: 'center',
    backgroundColor: t.colors.surface,
  },
  dateText: {
    fontSize: t.type.md,
    color: t.colors.text,
  },
  noteInput: {
    minHeight: 88,
    textAlignVertical: 'top',
  },
  hint: {
    fontSize: t.type.xs,
    color: t.colors.textMuted,
  },
}));
