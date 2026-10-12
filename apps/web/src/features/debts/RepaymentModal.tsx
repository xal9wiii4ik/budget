import { zodResolver } from '@hookform/resolvers/zod';
import { formatMoney, parseMoney, toInputString, todayApiDate } from '@budget/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';

import { Button } from '../../components/Button';
import { Field, Input, Textarea } from '../../components/Field';
import { Modal } from '../../components/Modal';
import { useAccounts } from '../../data/accounts';
import {
  useCreateRepayment,
  useUpdateRepayment,
  type DebtRead,
  type DebtRepaymentRead,
} from '../../data/debts';
import { useFxPreview, type FxConvertParams } from '../../data/fx';
import { useLang, useLocale, useT } from '../../i18n/context';
import { describeDebtError } from '../../lib/errors';
import { queryPhase } from '../../lib/queryPhase';
import { useDebouncedValue } from '../../lib/useDebouncedValue';
import type { AccountRead } from '../../data/accounts';
import { AccountField } from '../accounts/AccountField';
import {
  accountFieldBlocked,
  accountIndex,
  type NamedAccount,
} from '../accounts/accountOptions';
import { pickDefaultAccount, readLastAccountId } from '../accounts/lastAccount';
import {
  repaymentFormSchema,
  DEBT_NOTE_MAX,
  type RepaymentFormInput,
  type RepaymentFormValues,
} from './debtFormSchema';
import { buildRepaymentPatch } from './debtPatch';
import styles from './DebtFormModal.module.css';

const API_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PREVIEW_DEBOUNCE_MS = 400;

interface RepaymentModalProps {
  /**
   * The LIVE row out of the cached list, looked up by id by the caller — never a
   * snapshot. The remaining amount is both a hint here and the figure the
   * `DEBT_REPAYMENT_EXCEEDS_REMAINING` refusal names, so a stale one would offer
   * a sum the server must reject and then explain the rejection with the number
   * the user just typed.
   */
  debt: DebtRead;
  /** `undefined` = record a new repayment; a row = correct a recorded one. */
  repayment?: DebtRepaymentRead;
  onClose: () => void;
}

/**
 * One repayment: part of the debt comes back (task.md §Частичные возвраты).
 *
 * The amount is in the DEBT's currency — that is what the counterparty counts as
 * repaid — and the same cross-currency rule as the debt form applies: an account
 * in another currency needs its own figure, prefilled once from `/fx/convert`
 * and never computed here.
 *
 * The REMAINING amount is shown as a hint on create only. On an edit it would
 * have to be "remaining plus what this row already contributes", which is client
 * money arithmetic — the ceiling is server state under a row lock anyway
 * (`DEBT_REPAYMENT_EXCEEDS_REMAINING`), and that refusal is rendered on the
 * amount field with the figure in it.
 */
export function RepaymentModal({ debt, repayment, onClose }: RepaymentModalProps) {
  const lang = useLang();
  const locale = useLocale();
  const t = useT();
  const isEdit = repayment !== undefined;

  const accountsQuery = useAccounts();
  const accounts = useMemo(() => accountsQuery.data ?? [], [accountsQuery.data]);
  const accountsPhase = queryPhase(accountsQuery);
  const byId = useMemo(() => accountIndex(accounts), [accounts]);
  const currencyOf = useMemo(() => (id: string) => byId.get(id)?.currency, [byId]);

  const createRepayment = useCreateRepayment();
  const updateRepayment = useUpdateRepayment();



  const defaultValues: RepaymentFormInput = repayment
    ? {
        amount: toInputString(repayment.amount_minor, debt.currency),
        account_id: repayment.account_id,
        account_amount:
          repayment.account_currency === debt.currency
            ? ''
            : toInputString(repayment.account_amount_minor, repayment.account_currency),
        occurred_at: repayment.occurred_at,
        note: repayment.note ?? '',
      }
    : {
        amount: '',
        account_id: defaultRepaymentAccount(accounts, byId, debt),
        account_amount: '',
        occurred_at: todayApiDate(),
        note: '',
      };

  const initial: RepaymentFormValues = {
    amount_minor: repayment?.amount_minor ?? 0,
    account_id: repayment?.account_id ?? '',
    account_amount_minor:
      repayment !== undefined && repayment.account_currency !== debt.currency
        ? repayment.account_amount_minor
        : null,
    occurred_at: repayment?.occurred_at ?? '',
    note: repayment?.note ?? null,
  };

  const {
    control,
    register,
    handleSubmit,
    setError,
    setValue,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<RepaymentFormInput, unknown, RepaymentFormValues>({
    resolver: zodResolver(repaymentFormSchema(t, debt.currency, currencyOf)),
    defaultValues,
  });

  const accountId = useWatch({ control, name: 'account_id' });
  const amountRaw = useWatch({ control, name: 'amount' });
  const occurredAt = useWatch({ control, name: 'occurred_at' });
  const accountCurrency = byId.get(accountId)?.currency;
  const needsAccountAmount = accountCurrency !== undefined && accountCurrency !== debt.currency;

  // Seeded once when the account list lands: this modal opens over /debts, which
  // does not hold that list, so the first render cannot resolve a default (the
  // DebtFormModal rule — same guard, same reason).
  const seededAccount = useRef(false);
  useEffect(() => {
    if (isEdit || seededAccount.current) return;
    if (accountsPhase !== 'ready') return;
    seededAccount.current = true;
    if (accountId !== '') return;
    const next = defaultRepaymentAccount(accounts, byId, debt);
    if (next !== '') setValue('account_id', next, { shouldDirty: false });
  }, [isEdit, accountsPhase, accounts, byId, debt, accountId, setValue]);

  const [accountAmountEdited, setAccountAmountEdited] = useState(false);
  const debouncedAmount = useDebouncedValue(amountRaw, PREVIEW_DEBOUNCE_MS);
  const debouncedDate = useDebouncedValue(occurredAt, PREVIEW_DEBOUNCE_MS);
  const previewParams = useMemo(() => {
    if (!needsAccountAmount || accountCurrency === undefined) return null;
    if (!API_DATE_PATTERN.test(debouncedDate)) return null;
    const parsed = parseMoney(debouncedAmount, debt.currency);
    if (!parsed.ok || parsed.minor <= 0) return null;
    return {
      amountMinor: parsed.minor,
      from: debt.currency,
      to: accountCurrency,
      date: debouncedDate,
    } satisfies FxConvertParams;
  }, [needsAccountAmount, accountCurrency, debt.currency, debouncedAmount, debouncedDate]);
  const preview = useFxPreview(isEdit || accountAmountEdited ? null : previewParams);
  const previewResult = preview.data;

  useEffect(() => {
    if (isEdit || accountAmountEdited) return;
    if (previewResult === undefined) return;
    setValue(
      'account_amount',
      previewResult.converted_minor === null
        ? ''
        : toInputString(previewResult.converted_minor, previewResult.to),
      { shouldDirty: false, shouldValidate: false },
    );
  }, [previewResult, accountAmountEdited, isEdit, setValue]);

  const accountReg = register('account_id');
  const accountAmountReg = register('account_amount');

  const onSubmit = handleSubmit(async (values) => {
    try {
      if (isEdit && repayment) {
        const patch = buildRepaymentPatch(values, initial);
        if (Object.keys(patch).length > 0) {
          await updateRepayment.mutateAsync({
            debtId: debt.id,
            repaymentId: repayment.id,
            body: patch,
          });
        }
      } else {
        await createRepayment.mutateAsync({
          debtId: debt.id,
          body: {
            amount_minor: values.amount_minor,
            account_id: values.account_id,
            occurred_at: values.occurred_at,
            // Omitted, not null, when the currencies match (the server copies).
            ...(values.account_amount_minor === null
              ? {}
              : { account_amount_minor: values.account_amount_minor }),
            note: values.note,
          },
        });
      }
      onClose();
    } catch (error) {
      const { field, message, code } = describeDebtError(error, lang, t);
      // The ONE refusal a correct client can hit: remaining is server state, and
      // the honest message names the figure the user has in front of them. The
      // table cannot build it — the number lives on the debt, not in the body.
      const text =
        code === 'DEBT_REPAYMENT_EXCEEDS_REMAINING'
          ? t('repayment.exceedsRemaining', {
              remaining: formatMoney(debt.remaining_minor, debt.currency, { locale }),
            })
          : message;
      const target =
        field === 'form'
          ? 'root'
          : field === 'amount_minor'
            ? 'amount'
            : field === 'account_amount_minor'
              ? 'account_amount'
              : // Three fields that belong to the DEBT, not to one of its
                // repayments: a code naming them belongs at form level here.
                field === 'counterparty' || field === 'opened_on' || field === 'due_on'
                ? 'root'
                : field;
      setError(target, { message: text });
    }
  });

  const pending = isSubmitting || createRepayment.isPending || updateRepayment.isPending;
  const blocked = accountFieldBlocked(accountsPhase, accounts, repayment?.account_id);

  return (
    <Modal
      title={t(isEdit ? 'repayment.editTitle' : 'repayment.newTitle')}
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

        {/* The counterparty is user text; the figure is the SERVER's remaining. */}
        <p className={styles.lede}>
          {debt.counterparty}
          {isEdit ? null : (
            <>
              {' · '}
              {t('repayment.remainingHint', {
                amount: formatMoney(debt.remaining_minor, debt.currency, { locale }),
              })}
            </>
          )}
        </p>

        <Field
          label={t('repayment.amount', { currency: debt.currency })}
          htmlFor="repayment-amount"
          error={errors.amount?.message}
        >
          <Input
            id="repayment-amount"
            inputMode="decimal"
            className="tnum"
            aria-invalid={errors.amount ? true : undefined}
            {...register('amount')}
          />
        </Field>

        <AccountField
          id="repayment-account"
          label={t('debtForm.account')}
          // Which way the money goes on a repayment is the OPPOSITE of the debt's
          // own movement: a debt I lent out comes back IN, one I borrowed goes OUT.
          hint={t(
            debt.direction === 'lent'
              ? 'repayment.accountHintLent'
              : 'repayment.accountHintBorrowed',
          )}
          registration={accountReg}
          accounts={accounts}
          phase={accountsPhase}
          onRetry={() => {
            void accountsQuery.refetch();
          }}
          currentId={repayment?.account_id}
          errorMessage={errors.account_id?.message}
        />

        {needsAccountAmount && accountCurrency !== undefined ? (
          <Field
            label={t('debtForm.accountAmount', { currency: accountCurrency })}
            htmlFor="repayment-account-amount"
            hintId="repayment-account-amount-hint"
            hint={
              <>
                {t('debtForm.accountAmountHint')}
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
              id="repayment-account-amount"
              inputMode="decimal"
              className="tnum"
              aria-invalid={errors.account_amount ? true : undefined}
              aria-describedby="repayment-account-amount-hint"
              {...accountAmountReg}
              onChange={(event) => {
                void accountAmountReg.onChange(event);
                setAccountAmountEdited(true);
              }}
            />
          </Field>
        ) : null}

        <Field
          label={t('common.date')}
          htmlFor="repayment-date"
          error={errors.occurred_at?.message}
        >
          <Input
            id="repayment-date"
            type="date"
            aria-invalid={errors.occurred_at ? true : undefined}
            {...register('occurred_at')}
          />
        </Field>

        <Field
          label={
            <>
              {t('common.note')} <span className={styles.hint}>{t('common.optional')}</span>
            </>
          }
          htmlFor="repayment-note"
          error={errors.note?.message}
        >
          <Textarea
            id="repayment-note"
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

/**
 * Which account a NEW repayment starts on: the debt's OWN account, because that
 * is the one account this screen knows is involved — unless it has since been
 * ARCHIVED, which takes no new operations (422 `ACCOUNT_ARCHIVED`) and which the
 * picker does not offer, so seeding it would leave the select showing nothing
 * while the form held an id. The remembered default is the fallback.
 *
 * Module level, not a closure: it is read from two places (the mount defaults and
 * the seed effect) and must not become an effect dependency that changes identity
 * on every render.
 */
function defaultRepaymentAccount(
  accounts: AccountRead[],
  byId: Map<string, NamedAccount>,
  debt: DebtRead,
): string {
  const own = byId.get(debt.account_id);
  if (own !== undefined && !own.archived) return debt.account_id;
  return pickDefaultAccount(accounts, readLastAccountId());
}
