import { zodResolver } from '@hookform/resolvers/zod';
import { formatMoney, parseMoney, toInputString, todayApiDate } from '@budget/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';

import { Button } from '../../components/Button';
import { CurrencySelect } from '../../components/CurrencySelect';
import { Field, Input, Textarea } from '../../components/Field';
import { Modal } from '../../components/Modal';
import { currencyOptions } from '../../components/currencyOptions';
import { useAccounts } from '../../data/accounts';
import { useCreateDebt, useUpdateDebt, type DebtRead } from '../../data/debts';
import { useFxPreview, type FxConvertParams } from '../../data/fx';
import { useLang, useLocale, useT } from '../../i18n/context';
import { describeDebtError } from '../../lib/errors';
import { queryPhase } from '../../lib/queryPhase';
import { useDebouncedValue } from '../../lib/useDebouncedValue';
import { AccountField } from '../accounts/AccountField';
import { accountFieldBlocked, accountIndex } from '../accounts/accountOptions';
import {
  pickDefaultAccount,
  readLastAccountId,
  rememberLastAccountId,
} from '../accounts/lastAccount';
import {
  debtFormSchema,
  DEBT_COUNTERPARTY_MAX,
  DEBT_NOTE_MAX,
  type DebtFormInput,
  type DebtFormValues,
} from './debtFormSchema';
import { buildDebtPatch } from './debtPatch';
import styles from './DebtFormModal.module.css';

// `opened_on` as the date input produces it: a half-typed date must not be sent
// to the conversion preview.
const API_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PREVIEW_DEBOUNCE_MS = 400;

interface DebtFormModalProps {
  /** `undefined` = create mode; a debt = edit mode. */
  debt?: DebtRead;
  onClose: () => void;
}

/**
 * Record or edit one debt.
 *
 * Two fields are CREATE-ONLY, both because the server makes them immutable:
 * `direction` (lent vs borrowed decides the kind of every movement — a flip
 * would have to rewrite them all) and `currency` (the debt is counted in it).
 * On edit they are read-only TEXT rather than disabled controls: a disabled
 * control reads as "temporarily unavailable", while these are permanent — and
 * the hint names the way out (delete it and record it again, which is what the
 * real DELETE on a debt exists for).
 *
 * The amount is in the DEBT's currency. When the chosen account is denominated
 * in another one, a SECOND amount appears — what the bank actually moved on that
 * account — and it is the user's own figure: the transfer precedent, upheld by
 * senior-lead (amendment 1). `/fx/convert` only PREFILLS it, once, while it is
 * untouched and only on create; the client never multiplies by a rate itself,
 * and on edit the stored figure is the truth on screen.
 */
export function DebtFormModal({ debt, onClose }: DebtFormModalProps) {
  const lang = useLang();
  const locale = useLocale();
  const t = useT();
  const isEdit = debt !== undefined;

  // Server state via Query (the same 60s-cached archived-inclusive entry every
  // other money form reads); its phase is what the picker renders honestly.
  const accountsQuery = useAccounts();
  const accounts = useMemo(() => accountsQuery.data ?? [], [accountsQuery.data]);
  const accountsPhase = queryPhase(accountsQuery);
  const byId = useMemo(() => accountIndex(accounts), [accounts]);
  const currencyOf = useMemo(() => (id: string) => byId.get(id)?.currency, [byId]);

  const createDebt = useCreateDebt();
  const updateDebt = useUpdateDebt();

  // The debt currency a NEW debt starts on. It follows the picked account from
  // here on (see the effect below); the first option is only the value the select
  // holds until an account is known.
  const startingCurrency = debt?.currency ?? currencyOptions()[0];
  const startingAccountId = debt?.account_id ?? pickDefaultAccount(accounts, readLastAccountId());

  const defaultValues: DebtFormInput = debt
    ? {
        direction: debt.direction,
        counterparty: debt.counterparty,
        currency: debt.currency,
        // The principal IS the opening movement's amount in the debt currency
        // (the debts table stores no money), decoded at that currency — AM-5.
        amount: toInputString(debt.principal_minor, debt.currency),
        account_id: debt.account_id,
        account_amount:
          debt.account_currency === debt.currency
            ? ''
            : toInputString(debt.account_amount_minor, debt.account_currency),
        opened_on: debt.opened_on,
        due_on: debt.due_on ?? '',
        note: debt.note ?? '',
      }
    : {
        direction: 'lent',
        counterparty: '',
        currency: startingCurrency,
        amount: '',
        account_id: startingAccountId,
        account_amount: '',
        // The user's own calendar (`todayApiDate` is LOCAL): this is the day they
        // are choosing, not one the server decided. A date in the past is the
        // headline case and has no lower bound.
        opened_on: todayApiDate(),
        due_on: '',
        note: '',
      };

  // Output-shaped baseline for the PATCH diff.
  const initial: DebtFormValues = {
    direction: debt?.direction ?? 'lent',
    counterparty: debt?.counterparty ?? '',
    // Diff BASELINE only: the builder emits no currency key (immutable) and the
    // create branch never reaches the builder.
    currency: startingCurrency,
    amount_minor: debt?.principal_minor ?? 0,
    account_id: debt?.account_id ?? '',
    // `null` means "the account shares the debt's currency, so there is no second
    // figure" — the same shape the schema produces, so an untouched form diffs
    // as unchanged.
    account_amount_minor:
      debt !== undefined && debt.account_currency !== debt.currency
        ? debt.account_amount_minor
        : null,
    opened_on: debt?.opened_on ?? '',
    due_on: debt?.due_on ?? null,
    note: debt?.note ?? null,
  };

  const {
    control,
    register,
    handleSubmit,
    setError,
    setValue,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<DebtFormInput, unknown, DebtFormValues>({
    resolver: zodResolver(debtFormSchema(t, currencyOf)),
    defaultValues,
  });

  const direction = useWatch({ control, name: 'direction' });
  const currency = useWatch({ control, name: 'currency' });
  const accountId = useWatch({ control, name: 'account_id' });
  const amountRaw = useWatch({ control, name: 'amount' });
  const openedOn = useWatch({ control, name: 'opened_on' });
  const accountCurrency = byId.get(accountId)?.currency;
  // The second amount exists exactly while the two currencies differ — which is
  // also precisely when the server requires it (DEBT_ACCOUNT_AMOUNT_REQUIRED) and
  // refuses it otherwise (DEBT_ACCOUNT_AMOUNT_NOT_APPLICABLE).
  const needsAccountAmount = accountCurrency !== undefined && accountCurrency !== currency;

  // The debt currency FOLLOWS the picked account — but only while the user has
  // not chosen one themselves. Same rule, and same reason, as the transfer form's
  // amount mirror (`mirrorDecision` in @budget/shared): a value the form wrote may
  // be overwritten by the form, a value a human chose may not. The receipt is a
  // ref because it renders nothing — it only remembers. Deliberately NOT derived
  // from the form library's dirty flags: that was the shipped transfer-form defect.
  const ourCurrency = useRef<string>(startingCurrency);
  useEffect(() => {
    // Edit mode never writes it: the currency is immutable and rendered as text.
    if (isEdit) return;
    if (accountCurrency === undefined) return;
    if (currency !== ourCurrency.current) return;
    if (accountCurrency === currency) return;
    ourCurrency.current = accountCurrency;
    setValue('currency', accountCurrency, { shouldDirty: false });
  }, [isEdit, accountCurrency, currency, setValue]);

  // The remembered default account cannot be read at MOUNT here: /debts does not
  // hold the account list, so the form's first render has an empty one and
  // `defaultValues` falls back to "". Seeded ONCE when the list arrives, and only
  // while the field is still empty — the picker does not render at all until the
  // list is ready, so there is no user choice this can overwrite.
  const seededAccount = useRef(false);
  useEffect(() => {
    if (isEdit || seededAccount.current) return;
    if (accountsPhase !== 'ready') return;
    seededAccount.current = true;
    if (accountId !== '') return;
    const next = pickDefaultAccount(accounts, readLastAccountId());
    if (next !== '') setValue('account_id', next, { shouldDirty: false });
  }, [isEdit, accountsPhase, accounts, accountId, setValue]);

  // The second amount's prefill. EXPLICIT edited flag rather than RHF's dirty
  // state (the TransactionFormModal rule): `isDirty` compares against the
  // defaults, so a user who types the suggested figure back would silently hand
  // the field back to the preview.
  const [accountAmountEdited, setAccountAmountEdited] = useState(false);
  const debouncedAmount = useDebouncedValue(amountRaw, PREVIEW_DEBOUNCE_MS);
  const debouncedDate = useDebouncedValue(openedOn, PREVIEW_DEBOUNCE_MS);
  // `parseMoney` here only ENCODES the query parameter; the conversion itself is
  // the server's (D8).
  const previewParams = useMemo(() => {
    if (!needsAccountAmount || accountCurrency === undefined) return null;
    if (!API_DATE_PATTERN.test(debouncedDate)) return null;
    const parsed = parseMoney(debouncedAmount, currency);
    if (!parsed.ok || parsed.minor <= 0) return null;
    return {
      amountMinor: parsed.minor,
      from: currency,
      to: accountCurrency,
      date: debouncedDate,
    } satisfies FxConvertParams;
  }, [needsAccountAmount, accountCurrency, currency, debouncedAmount, debouncedDate]);
  // Create-only (the edit form's stored figure is the truth on screen).
  const preview = useFxPreview(isEdit || accountAmountEdited ? null : previewParams);
  const previewResult = preview.data;

  useEffect(() => {
    if (isEdit || accountAmountEdited) return;
    if (previewResult === undefined) return;
    // No rate for the pair → "" rather than a stale number: the field then reads
    // as empty with the no-rate hint under it, and the user types the real figure.
    setValue(
      'account_amount',
      previewResult.converted_minor === null
        ? ''
        : // AM-5: decoded with the `to` currency the server echoed.
          toInputString(previewResult.converted_minor, previewResult.to),
      { shouldDirty: false, shouldValidate: false },
    );
  }, [previewResult, accountAmountEdited, isEdit, setValue]);

  const directionReg = register('direction');
  const accountReg = register('account_id');
  const accountAmountReg = register('account_amount');

  const onSubmit = handleSubmit(async (values) => {
    try {
      if (isEdit && debt) {
        const patch = buildDebtPatch(values, initial);
        if (Object.keys(patch).length > 0) {
          await updateDebt.mutateAsync({ id: debt.id, body: patch });
        }
      } else {
        await createDebt.mutateAsync({
          direction: values.direction,
          counterparty: values.counterparty,
          currency: values.currency,
          amount_minor: values.amount_minor,
          account_id: values.account_id,
          opened_on: values.opened_on,
          // OMITTED, not null, when the account shares the debt's currency: the
          // server copies the amount itself and refuses a second figure.
          ...(values.account_amount_minor === null
            ? {}
            : { account_amount_minor: values.account_amount_minor }),
          due_on: values.due_on,
          note: values.note,
        });
        rememberLastAccountId(values.account_id);
      }
      onClose();
    } catch (error) {
      const { field, message } = describeDebtError(error, lang, t);
      const target =
        field === 'form'
          ? 'root'
          : field === 'amount_minor'
            ? 'amount'
            : field === 'account_amount_minor'
              ? 'account_amount'
              : // `occurred_at` belongs to a REPAYMENT; a code naming it cannot be
                // about a control on this form.
                field === 'occurred_at'
                ? 'root'
                : field;
      setError(target, { message });
    }
  });

  const pending = isSubmitting || createDebt.isPending || updateDebt.isPending;
  // No account, or a list that never arrived: there is nothing valid to submit,
  // and `AccountField` renders WHY. The account the form STARTS on stays
  // selectable even when archived (the recurring-book-now rule) — dropping it
  // would silently move the movement to another account.
  const blocked = accountFieldBlocked(accountsPhase, accounts, debt?.account_id);

  return (
    <Modal
      title={t(isEdit ? 'debtForm.editTitle' : 'debtForm.newTitle')}
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

        {/* What saving this will DO, said before the fields: one operation on the
            account, in no statistic and no budget (task.md §Связь со счетами).
            CREATE only — editing a recorded debt adds no second operation, it
            corrects the one that already exists. */}
        {isEdit ? null : <p className={styles.lede}>{t('debtForm.movementNote')}</p>}

        {isEdit ? (
          <Field
            label={t('debtForm.direction')}
            htmlFor="debt-direction"
            hint={t('debtForm.directionImmutableHint')}
          >
            {/* Read-only TEXT: the direction of a recorded debt is immutable, and
                a disabled control would read as "temporarily unavailable". */}
            <p className={styles.readOnlyValue} id="debt-direction">
              {t(
                initial.direction === 'lent'
                  ? 'debtForm.directionLent'
                  : 'debtForm.directionBorrowed',
              )}
            </p>
          </Field>
        ) : (
          /* A real <fieldset>/<legend> (the shipped kind-radios pattern): the
              name, the checked state, arrow-key navigation and the group's
              accessible name are all the browser's. It is NOT a <Field>, whose
              DOM order is label → control → hint → error. The direction comes
              first because two labels below are worded by it. */
          <fieldset className={styles.fieldset}>
            <legend className={styles.legend}>{t('debtForm.direction')}</legend>
            <div className={styles.radios}>
              <label className={styles.radio}>
                <input type="radio" value="lent" {...directionReg} />
                {t('debtForm.directionLent')}
              </label>
              <label className={styles.radio}>
                <input type="radio" value="borrowed" {...directionReg} />
                {t('debtForm.directionBorrowed')}
              </label>
            </div>
            <p className={styles.fieldHint}>{t('debtForm.directionCreateHint')}</p>
            {errors.direction?.message ? (
              <p className={styles.fieldError} role="alert">
                {errors.direction.message}
              </p>
            ) : null}
          </fieldset>
        )}

        <Field
          label={t('debtForm.counterparty')}
          htmlFor="debt-counterparty"
          hint={t('debtForm.counterpartyHint')}
          error={errors.counterparty?.message}
        >
          <Input
            id="debt-counterparty"
            maxLength={DEBT_COUNTERPARTY_MAX}
            aria-invalid={errors.counterparty ? true : undefined}
            {...register('counterparty')}
          />
        </Field>

        <AccountField
          id="debt-account"
          label={t('debtForm.account')}
          hint={t(
            direction === 'lent' ? 'debtForm.accountHintLent' : 'debtForm.accountHintBorrowed',
          )}
          registration={accountReg}
          accounts={accounts}
          phase={accountsPhase}
          onRetry={() => {
            void accountsQuery.refetch();
          }}
          currentId={debt?.account_id}
          errorMessage={errors.account_id?.message}
        />

        <Field
          label={t('common.currency')}
          htmlFor="debt-currency"
          hint={t(isEdit ? 'debtForm.currencyImmutableHint' : 'debtForm.currencyCreateHint')}
          error={errors.currency?.message}
        >
          {isEdit ? (
            <p className={styles.readOnlyValue} id="debt-currency">
              {initial.currency}
            </p>
          ) : (
            <CurrencySelect
              id="debt-currency"
              registration={register('currency')}
              onChange={() => {
                // A human choice: the account may never overwrite it again.
                ourCurrency.current = '';
              }}
            />
          )}
        </Field>

        <Field
          label={t('debtForm.amountIn', { currency })}
          htmlFor="debt-amount"
          error={errors.amount?.message}
        >
          <Input
            id="debt-amount"
            inputMode="decimal"
            className="tnum"
            aria-invalid={errors.amount ? true : undefined}
            {...register('amount')}
          />
        </Field>

        {/* Appears exactly while the account is in another currency. Not hidden
            behind a toggle: when the two differ there is no single amount, and the
            server will not invent the second one. */}
        {needsAccountAmount && accountCurrency !== undefined ? (
          <Field
            label={t('debtForm.accountAmount', { currency: accountCurrency })}
            htmlFor="debt-account-amount"
            hintId="debt-account-amount-hint"
            hint={
              <>
                {t('debtForm.accountAmountHint')}
                {/* The preview is a SUGGESTION with its provenance named; the
                    no-rate arm is a degraded state, not an error. */}
                {!isEdit && previewResult !== undefined ? (
                  <>
                    {' '}
                    {previewResult.converted_minor === null
                      ? t('debtForm.fxNoRate')
                      : t('debtForm.fxPrefill', {
                          amount: formatMoney(previewResult.converted_minor, previewResult.to, {
                            locale,
                          }),
                        })}
                  </>
                ) : null}
              </>
            }
            error={errors.account_amount?.message}
          >
            <Input
              id="debt-account-amount"
              inputMode="decimal"
              className="tnum"
              aria-invalid={errors.account_amount ? true : undefined}
              aria-describedby="debt-account-amount-hint"
              {...accountAmountReg}
              onChange={(event) => {
                void accountAmountReg.onChange(event);
                // A real keystroke hands the field to the user for good.
                setAccountAmountEdited(true);
              }}
            />
          </Field>
        ) : null}

        <Field
          label={t('debtForm.openedOn')}
          htmlFor="debt-opened-on"
          hint={t('debtForm.openedOnHint')}
          hintId="debt-opened-on-hint"
          error={errors.opened_on?.message}
        >
          <Input
            id="debt-opened-on"
            type="date"
            aria-invalid={errors.opened_on ? true : undefined}
            aria-describedby="debt-opened-on-hint"
            {...register('opened_on')}
          />
        </Field>

        <Field
          label={
            <>
              {t('debtForm.dueOn')} <span className={styles.hint}>{t('common.optional')}</span>
            </>
          }
          htmlFor="debt-due-on"
          hint={t('debtForm.dueOnHint')}
          hintId="debt-due-on-hint"
          error={errors.due_on?.message}
        >
          <Input
            id="debt-due-on"
            type="date"
            aria-invalid={errors.due_on ? true : undefined}
            aria-describedby="debt-due-on-hint"
            {...register('due_on')}
          />
        </Field>

        <Field
          label={
            <>
              {t('common.note')} <span className={styles.hint}>{t('common.optional')}</span>
            </>
          }
          htmlFor="debt-note"
          error={errors.note?.message}
        >
          <Textarea
            id="debt-note"
            maxLength={DEBT_NOTE_MAX}
            aria-invalid={errors.note ? true : undefined}
            {...register('note')}
          />
        </Field>

        <div className={styles.actions}>
          <span className={styles.spacer} />
          <Button type="submit" variant="primary" loading={pending} disabled={blocked}>
            {t(pending ? 'common.saving' : 'common.save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
