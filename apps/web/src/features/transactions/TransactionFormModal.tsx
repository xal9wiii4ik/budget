import { zodResolver } from '@hookform/resolvers/zod';
import {
  COUNTRY_CODES,
  countryToCurrency,
  formatApiDate,
  formatMoney,
  multiCurrencyTransactionFormSchema,
  parseMoney,
  todayApiDate,
  type MultiCurrencyTransactionFormInput,
  type MultiCurrencyTransactionFormValues,
} from '@budget/shared';
import { getErrorCode, type components } from '@budget/api-client';
import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { useForm, useWatch } from 'react-hook-form';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Modal } from '../../components/Modal';
import { useAccounts } from '../../data/accounts';
import { sortForDisplay } from '../../data/categoryLookup';
import { useFxPreview } from '../../data/fx';
import type { FxConvertParams } from '../../data/fx';
import {
  useCreateTransaction,
  useDeleteTransaction,
  useSummary,
  useUpdateTransaction,
} from '../../data/transactions';
import { useLang, useLocale, useT } from '../../i18n/context';
import { describeTransactionError } from '../../lib/errors';
import { ApiError } from '../../lib/query';
import { queryPhase } from '../../lib/queryPhase';
import { useDebouncedValue } from '../../lib/useDebouncedValue';
import { AccountField } from '../accounts/AccountField';
import { accountFieldBlocked, accountIndex } from '../accounts/accountOptions';
import {
  pickDefaultAccount,
  readLastAccountId,
  rememberLastAccountId,
} from '../accounts/lastAccount';
import { buildTransactionPatch, emptyToNull } from '@budget/api-client';
import { useProfile } from '../../data/profile';
import { AttachPhotoField } from './AttachPhotoField';
import { KIND_COPY } from './kindCopy';
import {
  describeOriginalPairError,
  isPairMode,
  migrateAmounts,
  spendCurrencyOptions,
  spendPrefill,
} from './originalPair';
import {
  buildConfirmDefaults,
  pickReceiptAccount,
  receiptCurrencyMismatch,
  type ReceiptAttachment,
} from './confirmDefaults';
import { ReceiptItemsList } from './ReceiptItemsList';
import { SpendCurrencyPicker } from './SpendCurrencyPicker';
import {
  buildCreateBody,
  editPrefillBaseAmount,
  previewAutofillValue,
  shouldShowConvertedSection,
} from './convertedSection';
import type { SimpleKey } from '../../i18n/t';
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
  // An uploaded receipt this form's transaction belongs to (S5/S6). `attach` only
  // adds `receipt_id` to the create body; `confirm` additionally starts the form
  // from the parsed receipt and sends `merchant`. Absent = the create/edit form
  // exactly as it was before receipts existed.
  receipt?: ReceiptAttachment;
}

/**
 * The edit form's starting values, straight off the stored row.
 *
 * Every money field is decoded with the currency IT is denominated in (AM-5):
 * the charge with the row's own `currency`, the spent amount with its
 * `original_currency` (S1), the base snapshot with its paired `base_currency`.
 * The spend-currency control starts on the pair's currency, or on the account's
 * — which is exactly what "this operation has one amount" looks like.
 */
function editDefaults(
  tx: TransactionRead,
  baseCurrency: string,
): MultiCurrencyTransactionFormInput {
  const spend = spendPrefill(tx);
  return {
    account_id: tx.account_id,
    amount: spend.amount,
    currency: tx.currency,
    original_amount: spend.originalAmount,
    original_currency: spend.spendCurrency,
    country: tx.country ?? '',
    merchant: tx.merchant ?? '',
    base_amount: editPrefillBaseAmount(tx, baseCurrency),
    // A transfer is edited in TransferFormModal (A1); this form never sees one,
    // so the narrow is a fact rather than a fallback.
    kind: tx.kind === 'income' ? 'income' : 'expense',
    category_id: tx.category_id ?? '',
    occurred_at: tx.occurred_at,
    note: tx.note ?? '',
  };
}

// The confirm-mode title KEY, kept next to the shell so the loading state and
// the form agree on what this dialog is called.
function modalTitleKey(isEdit: boolean, isConfirm: boolean): SimpleKey {
  if (isEdit) return 'txForm.editTitle';
  return isConfirm ? 'txForm.confirmTitle' : 'txForm.newTitle';
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
  receipt,
}: TransactionFormModalProps) {
  const t = useT();
  const summary = useSummary(month);
  const baseCurrency = summary.data?.currency;
  const title = t(modalTitleKey(transaction !== undefined, receipt?.mode === 'confirm'));

  if (baseCurrency === undefined) {
    return (
      <Modal title={title} onClose={onClose}>
        {summary.isError ? (
          <p className={styles.formError} role="alert">
            {t('form.baseCurrencyLoadFailed')}
          </p>
        ) : (
          <p className={styles.notice} role="status">
            {t('form.baseCurrencyLoading')}
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
      receipt={receipt}
    />
  );
}

interface TransactionFormProps {
  baseCurrency: string;
  transaction?: TransactionRead;
  categories: CategoryRead[];
  onClose: () => void;
  receipt?: ReceiptAttachment;
}

function TransactionForm({
  baseCurrency,
  transaction,
  categories,
  onClose,
  receipt,
}: TransactionFormProps) {
  const isEdit = transaction !== undefined;
  const lang = useLang();
  const locale = useLocale();
  const t = useT();
  // Confirm mode (S6). An edit never has a receipt attached (re-linking is not a
  // flow, D8), so the two modes cannot overlap.
  const confirm = receipt?.mode === 'confirm' ? receipt : undefined;

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

  // Server state via Query, not through props: this modal is opened from three
  // places (page, receipt flow) and the list is ONE 60s-cached entry, so the hook
  // is a cache hit while giving the field its honest loading/error phase.
  const accountsQuery = useAccounts();
  const accounts = useMemo(() => accountsQuery.data ?? [], [accountsQuery.data]);
  const accountsPhase = queryPhase(accountsQuery);
  const byId = useMemo(() => accountIndex(accounts), [accounts]);
  // Create mode's starting account: the remembered one, else the only account
  // there is, else unpicked (features/accounts/lastAccount.ts). Read once for the
  // form's defaults — RHF keeps the value from there on.
  //
  // OQ-W2: confirming a receipt prefers an account already in the RECEIPT's
  // currency, because the account decides the row's currency (§4). It never
  // guesses between several — see pickReceiptAccount.
  const [defaultAccountId] = useState(() => {
    const remembered = pickDefaultAccount(accounts, readLastAccountId());
    return confirm === undefined
      ? remembered
      : pickReceiptAccount(confirm.parsed.currency, accounts, remembered);
  });
  const defaultAccount = byId.get(defaultAccountId);

  // A transfer is edited in TransferFormModal (its own form, A1); this one only
  // ever sees expense/income rows, and the narrow says so instead of widening the
  // form's kind union to a value its radios cannot represent.
  const editKind = transaction?.kind === 'income' ? 'income' : 'expense';

  // The profile: the country a new operation starts in (S2) and, through it, the
  // currency the spend-currency control suggests first (S1). Never blocks the
  // form — the app has it cached from the language bootstrap, and a profile that
  // has not arrived simply contributes no default (an invented country would be
  // written to a real row).
  const profile = useProfile();
  const profileCountry = profile.data?.country ?? null;

  const defaultValues: MultiCurrencyTransactionFormInput = transaction
    ? editDefaults(transaction, baseCurrency)
    : confirm
      ? // S6: every prefilled value (including the AM-5 amount decode) comes from
        // one pure function, so the receipt->form crossing is unit-tested rather
        // than spread across this literal.
        {
          ...buildConfirmDefaults(
            confirm.parsed,
            confirm.suggestedCategoryId,
            categories,
            baseCurrency,
            defaultAccount,
          ),
          // A receipt says nothing about a second currency; the account's own
          // currency is the "one amount" sentinel.
          original_currency: defaultAccount?.currency ?? baseCurrency,
          original_amount: '',
          country: profileCountry ?? '',
        }
      : {
          account_id: defaultAccountId,
          amount: '',
          // S1: the spend currency DEFAULTS to the selected account's currency —
          // equal to it means "one amount, no pair" — and is a free choice from
          // there. It is deliberately not the profile country's currency: most
          // operations are in the account's own currency, and the country only
          // orders the suggestions.
          original_currency: defaultAccount?.currency ?? baseCurrency,
          original_amount: '',
          country: profileCountry ?? '',
          merchant: '',
          // Not a wire value and not a decode: the create body sends NO currency
          // (the server stamps it from the account, §4). It is the exponent the
          // amount input is parsed with, and it is rewritten the moment an
          // account is picked; the base currency is only what stands there while
          // nothing is picked yet — a state in which the form cannot be submitted
          // at all, because `account_id` is required.
          currency: defaultAccount?.currency ?? baseCurrency,
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
    account_id: transaction?.account_id ?? defaultAccountId,
    amount: transaction?.amount_minor ?? 0,
    // NOT a decode fallback (AM-5): this is the diff BASELINE, and the create
    // branch (no transaction) never reaches the patch builder at all.
    currency: transaction?.currency ?? baseCurrency,
    base_amount_minor: basePrefill === '' ? null : (transaction?.base_amount_minor ?? null),
    kind: editKind,
    category_id: transaction?.category_id ?? '',
    occurred_at: transaction?.occurred_at ?? '',
    note: transaction?.note ?? '',
    // The BASELINE of the merchant diff. `buildTransactionPatch` still emits no
    // merchant key — that guard protects the frozen mobile edit, whose form has
    // no such input and would clear a receipt-parsed merchant on every save
    // (patch.test.ts pins it). The web form DOES render the field now (S4), so it
    // diffs merchant itself, explicitly, in onSubmit.
    merchant: transaction?.merchant ?? '',
    // S1/S2: the stored pair and country as they are, so an untouched form sends
    // neither. `?? null` here is the ABSENCE of a pair, never a decode fallback.
    original_amount_minor: transaction?.original_amount_minor ?? null,
    original_currency: transaction?.original_currency ?? null,
    country: transaction?.country ?? '',
  };

  const {
    control,
    register,
    handleSubmit,
    setError,
    setValue,
    getValues,
    formState: { errors, dirtyFields, isSubmitting, isDirty },
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
  const selectedAccountId = useWatch({ control, name: 'account_id' });
  const amountRaw = useWatch({ control, name: 'amount' });
  const occurredAt = useWatch({ control, name: 'occurred_at' });
  const categoryId = useWatch({ control, name: 'category_id' });
  const showConverted = shouldShowConvertedSection(currency, baseCurrency);

  // Every direction-dependent label in this form, looked up from the WATCHED kind
  // during render (kindCopy.ts). No effect, no second copy of the kind in state:
  // flipping the radio re-renders and the words follow. The kind-switch LOGIC
  // (clearing a category whose kind no longer matches) is untouched by this.
  const kind = useWatch({ control, name: 'kind' });
  const copy = KIND_COPY[kind];

  // S1: the currency the money was SPENT in. Equal to the account's = one amount;
  // anything else = the pair, and a second field for what the account was charged.
  const spendCurrency = useWatch({ control, name: 'original_currency' }) ?? currency;
  const spentRaw = useWatch({ control, name: 'original_amount' }) ?? '';
  const pairMode = isPairMode(spendCurrency, currency);
  const spendOptions = spendCurrencyOptions({
    accountCurrency: currency,
    profileCurrency: countryToCurrency(profileCountry),
    accountCurrencies: accounts.map((account) => account.currency),
    current: spendCurrency,
  });

  // The photo this operation is linked to (S3). Client state, not server state:
  // it is an unsaved edit of the row until Save is pressed.
  const [receiptId, setReceiptId] = useState<string | null>(
    receipt?.id ?? transaction?.receipt_id ?? null,
  );
  const initialReceiptId = receipt?.id ?? transaction?.receipt_id ?? null;

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

  // OQ-W2 (second half): the printed currency vs the currency this row will
  // actually be saved in. Derived from the WATCHED account during render, so it
  // follows every change of the picker with no effect and no second copy of the
  // selection in state. `undefined` account (none picked, or an id the list does
  // not know) means there is nothing to compare — never a guessed currency.
  const currencyMismatch =
    confirm === undefined
      ? null
      : receiptCurrencyMismatch(
          confirm.parsed.currency,
          byId.get(selectedAccountId)?.currency,
        );

  // Where a preselected category came from — shown only while the selection is
  // still the suggested one, so it reads as an explanation of what is on screen
  // and not as a nag after the user has overridden it. Derived from the watched
  // value; no second copy of "was it changed" in state.
  const suggestionHint =
    confirm !== undefined &&
    confirm.suggestionSource !== null &&
    confirm.suggestedCategoryId !== null &&
    categoryId === confirm.suggestedCategoryId
      ? t(
          confirm.suggestionSource === 'merchant_map'
            ? 'txForm.suggestedFromSimilar'
            : 'txForm.suggestedFromReceipt',
        )
      : null;

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

  // S1: an ESTIMATE of what the account will be charged, for a create where the
  // user left the charge to the server. Text only — it is never written into the
  // field (the client does not multiply by rates, D8; the server computes the
  // stored value at save time). Its real job is telling the user BEFORE they save
  // that this currency pair has no rate, instead of after a 422.
  const debouncedSpent = useDebouncedValue(spentRaw, PREVIEW_DEBOUNCE_MS);
  const spentAmount = parseMoney(debouncedSpent, spendCurrency);
  const chargePreviewParams: FxConvertParams | null =
    !isEdit &&
    pairMode &&
    amountRaw.trim() === '' &&
    spentAmount.ok &&
    API_DATE_PATTERN.test(debouncedDate)
      ? { amountMinor: spentAmount.minor, from: spendCurrency, to: currency, date: debouncedDate }
      : null;
  const chargePreview = useFxPreview(chargePreviewParams);

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
  // Collated in the CHOSEN language, over the already-translated names.
  const sortedOptions = sortForDisplay(options, locale);
  const expenseOptions = sortedOptions.filter((category) => category.kind === 'expense');
  const incomeOptions = sortedOptions.filter((category) => category.kind === 'income');

  // S2: codes from the shared table, LABELS from the runtime — Intl already ships
  // country names in every locale the app runs in, so nothing is hand-translated
  // and the list follows the language switch for free. Collated in that same
  // locale, because alphabetical order is language-specific too.
  const countryOptions = useMemo(() => {
    const names = new Intl.DisplayNames([locale], { type: 'region' });
    return COUNTRY_CODES.map((code) => ({ code, label: names.of(code) ?? code })).sort((a, b) =>
      a.label.localeCompare(b.label, locale),
    );
  }, [locale]);

  const categoryReg = register('category_id');
  const kindReg = register('kind');
  const accountReg = register('account_id');
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

  // Picking another ACCOUNT is a currency change (architecture §4: the row is
  // denominated in its account's currency), so it does exactly what the old
  // currency picker did — restamp the form's currency and invalidate whatever
  // stood in the converted field: an autofilled preview, a typed override, and
  // (in edit mode) the stored snapshot, which belongs to the ORIGINAL currency.
  // Moving back to the row's own account restores the stored value.
  const onAccountChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const picked = byId.get(event.target.value);
    // An unknown id cannot happen from this <select>; leaving the currency alone
    // is the honest no-op (never a guessed exponent).
    if (picked) {
      setValue('currency', picked.currency, { shouldDirty: true });
      // S1: an operation with ONE amount keeps having one — the spend currency
      // follows the account. A pair keeps the currency the money was spent in;
      // if the new account happens to be held in that very currency the pair
      // collapses instead of colliding with the server's
      // ORIGINAL_CURRENCY_MATCHES_ACCOUNT rule.
      const nextSpend = pairMode ? spendCurrency : picked.currency;
      setValue('original_currency', nextSpend, { shouldDirty: true });
      const migrated = migrateAmounts(
        { amount: getValues('amount'), originalAmount: getValues('original_amount') ?? '' },
        pairMode,
        isPairMode(nextSpend, picked.currency),
      );
      setValue('amount', migrated.amount, { shouldDirty: true, shouldValidate: false });
      setValue('original_amount', migrated.originalAmount, {
        shouldDirty: true,
        shouldValidate: false,
      });
    }
    const restored =
      transaction && event.target.value === transaction.account_id ? basePrefill : '';
    setValue('base_amount', restored, { shouldDirty: true, shouldValidate: false });
    setBaseAmountEdited(false);
  };

  // S1: picking the currency the money was SPENT in. Uppercased on the way in so
  // a typed "eur" is the same choice as a picked "EUR" (the schema and the server
  // are both uppercase-only), and the two amount fields move with the mode — see
  // `migrateAmounts` for why the visible number stays where the user is looking.
  const onSpendCurrencyChange = (code: string) => {
    const next = code.toUpperCase();
    setValue('original_currency', next, { shouldDirty: true, shouldValidate: false });
    const migrated = migrateAmounts(
      { amount: getValues('amount'), originalAmount: getValues('original_amount') ?? '' },
      pairMode,
      isPairMode(next, currency),
    );
    setValue('amount', migrated.amount, { shouldDirty: true, shouldValidate: false });
    setValue('original_amount', migrated.originalAmount, {
      shouldDirty: true,
      shouldValidate: false,
    });
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
    dirtyFields.amount ||
      dirtyFields.currency ||
      dirtyFields.account_id ||
      dirtyFields.occurred_at,
  );
  const convertedHints: string[] = [];
  if (isEdit) {
    if (conversionInputDirty && !baseAmountEdited) {
      // PATCH row 6: any conversion input moving makes the server recompute.
      convertedHints.push(
        API_DATE_PATTERN.test(occurredAt)
          ? t('txForm.convertedRecalcDated', {
              date: formatApiDate(occurredAt, { locale }),
            })
          : t('txForm.convertedRecalc'),
      );
    }
  } else if (previewParams !== null) {
    if (preview.isPending) {
      convertedHints.push(t('txForm.converting'));
    } else if (preview.isError) {
      convertedHints.push(t('txForm.convertedFetchFailed', { currency: baseCurrency }));
    } else if (previewResult) {
      const rate = previewResult.rate;
      const rateAsOf = previewResult.rate_as_of;
      if (previewResult.converted_minor === null || rate === null || rateAsOf === null) {
        // Degradation, not failure: the field stays enabled and a typed value is
        // stored as the override, so an unsupported currency remains usable.
        convertedHints.push(
          t('txForm.convertedNoRate', { from: currency, to: baseCurrency }),
        );
      } else {
        // D2's disclosed rate date: shows when a weekend/stale rate was used.
        // `rate` is rendered VERBATIM (a server-quantized decimal string — never
        // reformatted, never parsed); only its date goes through the shared
        // locale formatter. No sentence period: locales like ru end the formatted
        // date in "г." and the template would double it ("… 2026 г..").
        convertedHints.push(
          t('txForm.convertedRate', {
            rate,
            date: API_DATE_PATTERN.test(rateAsOf)
              ? formatApiDate(rateAsOf, { locale })
              : rateAsOf,
          }),
        );
        if (!baseAmountEdited) {
          convertedHints.push(t('txForm.convertedEstimate'));
        }
      }
    }
  }

  // What the CHARGED field promises while it sits empty (S1). Four honest arms,
  // in the order the user meets them: the server has said it cannot convert this
  // pair; an edit whose spent amount moved; a live estimate; and the plain
  // default. Every one of them is text — none of them fills the field.
  const chargeHints: string[] = [];
  if (pairMode) {
    if (manualCharge) {
      chargeHints.push(t(copy.chargeManual, { from: spendCurrency, to: currency }));
    } else if (isEdit) {
      if ((dirtyFields.original_amount || dirtyFields.original_currency) && !dirtyFields.amount) {
        // PATCH row 4: the pair travels without amount_minor, so the server
        // recomputes the charge. Saying so beats a number silently changing.
        chargeHints.push(
          API_DATE_PATTERN.test(occurredAt)
            ? t('txForm.chargeRecalcDated', { date: formatApiDate(occurredAt, { locale }) })
            : t('txForm.chargeRecalc'),
        );
      }
    } else if (chargePreviewParams !== null) {
      const charge = chargePreview.data;
      if (chargePreview.isPending) {
        chargeHints.push(t('txForm.converting'));
      } else if (chargePreview.isError) {
        chargeHints.push(t('txForm.chargeFetchFailed', { currency }));
      } else if (charge) {
        if (charge.converted_minor === null || charge.rate === null) {
          // The normal answer for a pair outside the six canonical ones — said
          // here, before the save, instead of as a 422 afterwards.
          chargeHints.push(
            t('txForm.chargeNoRateAhead', { from: spendCurrency, to: currency }),
          );
        } else {
          // `rate` is the server's own decimal string, printed verbatim; the
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

  const onSubmit = handleSubmit(async (values) => {
    // The server has already told us it cannot convert this pair on this date
    // (see `manualCharge`): asking it again would only repeat the same 422, so
    // the ask lands on the field instead of on the network.
    if (pairMode && manualCharge && values.amount === null) {
      setError('amount', {
        message: t(copy.manualChargeRequired, { currency }),
      });
      return;
    }
    try {
      if (isEdit && transaction) {
        const patch = buildTransactionPatch(values, initial, baseCurrency);
        // `merchant` is diffed HERE, not in the shared builder: that builder must
        // keep emitting no merchant key at all, because the frozen mobile edit
        // form has no such input and would clear a receipt-parsed merchant on
        // every save (pinned in patch.test.ts). This form does render the field
        // (S4), so it owns the trichotomy: unchanged -> omit, "" -> null.
        if (values.merchant !== initial.merchant) {
          patch.merchant = emptyToNull(values.merchant);
        }
        // S3: attach / replace / detach, same trichotomy. Detaching removes the
        // LINK only — no delete endpoint is called, and none exists.
        if (receiptId !== initialReceiptId) patch.receipt_id = receiptId;
        if (Object.keys(patch).length > 0) {
          await updateTransaction.mutateAsync({
            id: transaction.id,
            body: patch,
            previousOccurredAt: transaction.occurred_at,
          });
        }
      } else {
        const body = buildCreateBody(values, baseCurrency, baseAmountEdited);
        // The receipt attachment: the row remembers which uploaded photo it came
        // from — the one the flow arrived with, or one attached here (S3).
        if (receiptId !== null) body.receipt_id = receiptId;
        // S4: the name of the operation, on EVERY create now — not just after a
        // receipt. It is also what the server learns the merchant->category
        // mapping from (D7). Same ""->null bridge as `note`.
        body.merchant = emptyToNull(values.merchant);
        await createTransaction.mutateAsync(body);
        rememberLastAccountId(values.account_id);
      }
      onClose();
    } catch (error) {
      // S1: the codes this form's two-amount model owns, before the shared layer
      // sees them. FX_RATE_UNAVAILABLE is the important one and it is NOT a
      // failure — only six canonical pairs have stored rates, so for anything
      // exotic the answer is "tell us what your bank charged", and the form
      // switches into that mode instead of showing an error the user cannot act on.
      const own = describeOriginalPairError(
        error instanceof ApiError ? getErrorCode(error.body) : undefined,
      );
      if (own) {
        if (own.needsManualCharge) {
          setRateGap({ from: spendCurrency, to: currency, date: getValues('occurred_at') });
        }
        setError(own.target === 'form' ? 'root' : own.target, {
          // The pure module names a dictionary KEY; the sentence is chosen here,
          // in whatever language is on screen.
          message: t(own.messageKey, { from: spendCurrency, to: currency }),
        });
        return;
      }
      // The 404 (TRANSACTION_NOT_FOUND) list refetch is handled by the mutation's
      // onError in data/transactions.ts; here we only route the error to the form.
      const { field, message } = describeTransactionError(error, lang);
      // The two transfer-only fields cannot be produced by THIS form, so they
      // fall back to the form root rather than naming a control that is not here.
      const target =
        field === 'form' ||
        field === 'counter_account_id' ||
        field === 'counter_amount_minor'
          ? 'root'
          : field === 'amount_minor'
            ? 'amount'
            : field;
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
      setDeleteError(describeTransactionError(error, lang).message);
    }
  };

  if (confirmingDelete && transaction) {
    return (
      <ConfirmDialog
        title={t('txForm.deleteTitle')}
        message={t('txForm.deleteMessage')}
        confirmLabel={t('common.delete')}
        pendingLabel={t('common.deleting')}
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
  // Nothing valid to send while the list has not arrived or has nothing to offer
  // (AccountField renders WHY on screen; this only owns the Save button).
  const noAccounts = accountFieldBlocked(accountsPhase, accounts, transaction?.account_id);

  return (
    <Modal
      title={t(modalTitleKey(isEdit, confirm !== undefined))}
      onClose={onClose}
      // Attaching or removing a photo is an unsaved edit too, and RHF knows
      // nothing about it (it is not a form field), so it joins the guard here.
      isDirty={isDirty || receiptId !== initialReceiptId}
    >
      <form className={styles.form} onSubmit={onSubmit} noValidate>
        {confirm ? (
          <p className={styles.hint}>{t('txForm.confirmLede')}</p>
        ) : null}

        {errors.root?.message ? (
          <p className={styles.formError} role="alert">
            {errors.root.message}
          </p>
        ) : null}

        {/* The kind comes FIRST (and only this control moves): every label below
            is worded by direction, so the form has to know which way the money
            went before the user starts filling it in. */}
        <fieldset className={styles.field}>
          <legend className={styles.label}>{t('common.type')}</legend>
          <div className={styles.kindGroup}>
            <label className={styles.kindOption}>
              <input type="radio" value="expense" {...kindReg} onChange={onKindChange} />
              {t('common.expense')}
            </label>
            <label className={styles.kindOption}>
              <input type="radio" value="income" {...kindReg} onChange={onKindChange} />
              {t('common.income')}
            </label>
          </div>
        </fieldset>

        <AccountField
          id="tx-account"
          label={t(copy.account)}
          registration={accountReg}
          accounts={accounts}
          phase={accountsPhase}
          onRetry={() => {
            void accountsQuery.refetch();
          }}
          currentId={transaction?.account_id}
          onChange={onAccountChange}
          errorMessage={errors.account_id?.message}
        />

        {/* Not an error and not a blocker: the amount is saved in the ACCOUNT's
            currency whatever the paper says, so the only thing that can go wrong
            here is a number nobody re-checked. Saying which two currencies are
            involved is the whole point — "currency mismatch" alone would leave
            the user guessing what to do. */}
        {currencyMismatch ? (
          <p className={styles.currencyWarning} role="status">
            {t('txForm.receiptCurrencyWarning', {
              receiptCurrency: currencyMismatch.receiptCurrency,
              accountCurrency: currencyMismatch.accountCurrency,
            })}
          </p>
        ) : null}

        {/* S1. The amount field NAMES its currency, always — "Amount" alone was
            the actual complaint. The currency next to it is the one the money was
            SPENT in: leave it on the account's and there is one amount, change it
            and a second field appears for what the account was charged.

            The slot holds `original_amount` in pair mode and `amount` otherwise,
            because to the user it is the same field ("how much was it, in what
            currency") — see migrateAmounts for what happens to the number when
            the mode flips. */}
        <div className={styles.field}>
          <div className={styles.amountRow}>
            <div className={styles.amountCol}>
              <label className={styles.label} htmlFor={pairMode ? 'tx-spent' : 'tx-amount'}>
                {pairMode
                  ? t(copy.spentLabel, { currency: spendCurrency })
                  : t(copy.amountLabel, { currency })}
              </label>
              {pairMode ? (
                <input
                  id="tx-spent"
                  inputMode="decimal"
                  className={
                    errors.original_amount ? `${styles.input} ${styles.inputError}` : styles.input
                  }
                  aria-invalid={errors.original_amount ? true : undefined}
                  {...register('original_amount')}
                />
              ) : (
                <input
                  id="tx-amount"
                  inputMode="decimal"
                  className={errors.amount ? `${styles.input} ${styles.inputError}` : styles.input}
                  aria-invalid={errors.amount ? true : undefined}
                  {...register('amount')}
                />
              )}
            </div>
            {/* Its own VISIBLE label, not just an aria one: with a bare code box
                and no caption the currency read as decoration, and the actual
                complaint was "I thought it could not be changed". The picker
                keeps any well-formed code reachable behind "other currency" —
                see SpendCurrencyPicker for why that escape hatch is load-bearing. */}
            <div className={styles.currencyCol}>
              <label className={styles.label} htmlFor="tx-spend-currency">
                {t(copy.spendCurrencyLabel)}
              </label>
              <SpendCurrencyPicker
                id="tx-spend-currency"
                value={spendCurrency}
                suggestions={spendOptions}
                onChange={onSpendCurrencyChange}
              />
            </div>
          </div>
          {errors.original_amount?.message ? (
            <p className={styles.fieldError} role="alert">
              {errors.original_amount.message}
            </p>
          ) : null}
          {!pairMode && errors.amount?.message ? (
            <p className={styles.fieldError} role="alert">
              {errors.amount.message}
            </p>
          ) : null}
          {errors.original_currency?.message ? (
            <p className={styles.fieldError} role="alert">
              {errors.original_currency.message}
            </p>
          ) : null}
          {errors.currency?.message ? (
            <p className={styles.fieldError} role="alert">
              {errors.currency.message}
            </p>
          ) : null}
          {!pairMode ? (
            <p className={styles.hint}>{t(copy.spendCurrencyHint)}</p>
          ) : null}
        </div>

        {/* S1: what the ACCOUNT was charged — the number that hits the balance.
            Optional: empty means "convert what I spent at that day's rate", and
            the server does that arithmetic, never this client (D8). */}
        {pairMode ? (
          <div className={styles.field}>
            <label className={styles.label} htmlFor="tx-charged">
              {t(copy.chargedLabel, { currency })}{' '}
              {/* Optional until the server says it cannot convert this pair —
                  from then on it is the only way the row can be saved. */}
              {manualCharge ? null : (
                <span className={styles.hint}>{t('common.optional')}</span>
              )}
            </label>
            <input
              id="tx-charged"
              inputMode="decimal"
              className={errors.amount ? `${styles.input} ${styles.inputError}` : styles.input}
              aria-invalid={errors.amount ? true : undefined}
              aria-describedby="tx-charged-hint"
              {...register('amount')}
            />
            {errors.amount?.message ? (
              <p className={styles.fieldError} role="alert">
                {errors.amount.message}
              </p>
            ) : null}
            <p className={styles.hint} id="tx-charged-hint" role="status">
              {chargeHints.join(' ')}
            </p>
          </div>
        ) : null}

        {showConverted ? (
          <fieldset className={styles.converted}>
            <legend className={styles.label}>
              {t('txForm.convertedLegend', { currency: baseCurrency })}
            </legend>
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
                {t('txForm.resetToAuto')}
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
                : t('txForm.convertedDefault', { currency: baseCurrency })}
            </p>
          </fieldset>
        ) : null}

        <div className={styles.field}>
          <label className={styles.label} htmlFor="tx-category">
            {t('txForm.category')} <span className={styles.hint}>{t('common.optional')}</span>
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
            <option value="">{t('common.uncategorized')}</option>
            {expenseOptions.length > 0 ? (
              <optgroup label={t('common.expense')}>
                {expenseOptions.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                    {category.archived ? ` ${t('common.archivedParens')}` : ''}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {incomeOptions.length > 0 ? (
              <optgroup label={t('common.income')}>
                {incomeOptions.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                    {category.archived ? ` ${t('common.archivedParens')}` : ''}
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
          {suggestionHint ? <p className={styles.hint}>{suggestionHint}</p> : null}
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="tx-date">
            {t('common.date')}
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

        {/* S4: the operation's NAME. Same `merchant` column the receipt flow
            fills in — no second field for the same fact — but it is no longer
            confirm-only: "Groceries" three times in a list tells nobody which
            shop that was. It is also what the server learns the
            merchant->category mapping from on create (D7). */}
        <div className={styles.field}>
          <label className={styles.label} htmlFor="tx-merchant">
            {t(copy.merchantLabel)}{' '}
            <span className={styles.hint}>{t('common.optional')}</span>
          </label>
          <input
            id="tx-merchant"
            className={errors.merchant ? `${styles.input} ${styles.inputError}` : styles.input}
            maxLength={255}
            aria-invalid={errors.merchant ? true : undefined}
            aria-describedby={copy.merchantHint ? 'tx-merchant-hint' : undefined}
            {...register('merchant')}
          />
          {errors.merchant?.message ? (
            <p className={styles.fieldError} role="alert">
              {errors.merchant.message}
            </p>
          ) : null}
          {/* "Source" alone reads like a dropdown; the hint says what to type. */}
          {copy.merchantHint ? (
            <p className={styles.hint} id="tx-merchant-hint">
              {t(copy.merchantHint)}
            </p>
          ) : null}
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="tx-note">
            {t('common.note')} <span className={styles.hint}>{t('common.optional')}</span>
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

        {/* S3: attaching a photo is NOT scanning it — this control uploads and
            links, and never calls the parser, so it works with no AI key at all. */}
        <AttachPhotoField receiptId={receiptId} onChange={setReceiptId} disabled={pending} />

        {/* S2: the country of the operation, folded away because it is a detail
            of a minority of rows — the user asked for it not to crowd the form.
            <details> rather than a hand-rolled disclosure: it is keyboard- and
            screen-reader-operable for free. */}
        <details className={styles.moreOptions}>
          <summary className={styles.moreSummary}>{t('txForm.moreOptions')}</summary>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="tx-country">
              {t('txForm.country')}{' '}
              <span className={styles.hint}>{t('common.optional')}</span>
            </label>
            <select
              id="tx-country"
              className={errors.country ? `${styles.select} ${styles.inputError}` : styles.select}
              aria-invalid={errors.country ? true : undefined}
              {...register('country')}
            >
              <option value="">{t('common.notSet')}</option>
              {countryOptions.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.label}
                </option>
              ))}
            </select>
            {errors.country?.message ? (
              <p className={styles.fieldError} role="alert">
                {errors.country.message}
              </p>
            ) : null}
          </div>
        </details>

        {confirm ? <ReceiptItemsList parsed={confirm.parsed} /> : null}

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
              {t('common.delete')}
            </button>
          ) : null}
          <span className={styles.spacer} />
          <button
            type="submit"
            className={styles.submit}
            // Nothing valid to send without an account; the notice above the form
            // says where to make one.
            disabled={pending || noAccounts}
          >
            {t(pending ? 'common.saving' : 'common.save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
