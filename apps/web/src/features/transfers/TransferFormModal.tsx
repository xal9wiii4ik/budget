import { zodResolver } from '@hookform/resolvers/zod';
import {
  mirrorDecision,
  toInputString,
  todayApiDate,
  transferFormSchema,
  type TransferFormInput,
  type TransferFormValues,
} from '@budget/shared';
import { buildTransferPatch, emptyToNull } from '@budget/api-client';
import type { components } from '@budget/api-client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm, useWatch, type UseFormRegisterReturn } from 'react-hook-form';

import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Field, Input, Textarea } from '../../components/Field';
import { Modal } from '../../components/Modal';
import { useAccounts } from '../../data/accounts';
import { useDeposits } from '../../data/deposits';
import {
  useCreateTransaction,
  useDeleteTransaction,
  useUpdateTransaction,
} from '../../data/transactions';
import { useLang, useT } from '../../i18n/context';
import { describeTransactionError } from '../../lib/errors';
import { queryPhase } from '../../lib/queryPhase';
import { AccountField } from '../accounts/AccountField';
import { accountFieldBlocked } from '../accounts/accountOptions';
import { mergedAccountIndex } from '../deposits/depositAccounts';
import {
  pickDefaultAccount,
  readLastAccountId,
  rememberLastAccountId,
} from '../accounts/lastAccount';
import styles from './TransferFormModal.module.css';

type TransactionRead = components['schemas']['TransactionRead'];

/**
 * One side of a NEW transfer, fixed by the screen that opened the form
 * (deposits W1). `accountId` is a LEDGER account id — for a deposit, the hidden
 * account behind it, which is exactly what a transfer stores.
 *
 * Create-only by contract: edit mode ignores it entirely (see below).
 */
export interface TransferPrefill {
  /** Which leg is fixed: 'source' = money leaves it, 'target' = it receives. */
  side: 'source' | 'target';
  accountId: string;
}

interface TransferFormModalProps {
  /** `undefined` = create mode; a `kind === 'transfer'` row = edit mode. */
  transfer?: TransactionRead;
  /**
   * Fixes one leg to a specific account and renders it as read-only text
   * instead of a picker (deposits W1). Deliberately IGNORED in edit mode: an
   * existing transfer's two legs are both editable and always have been, and a
   * prefill there would silently rewrite a stored row.
   */
  prefill?: TransferPrefill;
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
export function TransferFormModal({ transfer, prefill, onClose }: TransferFormModalProps) {
  const lang = useLang();
  const t = useT();
  const isEdit = transfer !== undefined;
  // Edit mode never takes a prefill (see the prop's doc): reading it once here
  // keeps that rule in ONE place instead of at every use below.
  const fixed = isEdit ? undefined : prefill;

  // Server state via Query (the same 60s-cached archived-inclusive entry every
  // other form reads); its phase is what the two pickers render honestly.
  const accountsQuery = useAccounts();
  const accounts = useMemo(() => accountsQuery.data ?? [], [accountsQuery.data]);
  const accountsPhase = queryPhase(accountsQuery);
  const retryAccounts = () => {
    void accountsQuery.refetch();
  };

  // deposits W1: a deposit's ledger account is HIDDEN from GET /accounts, so
  // without this second (60s-cached) read the form could not name — or decode
  // the currency of — a leg pointing at one. That is not only the new top-up
  // flow: EDITING a transfer that already touches a deposit resolves its
  // counter account through this same merged index.
  const depositsQuery = useDeposits();
  const deposits = useMemo(() => depositsQuery.data ?? [], [depositsQuery.data]);

  const createTransaction = useCreateTransaction();
  const updateTransaction = useUpdateTransaction();
  const deleteTransaction = useDeleteTransaction();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined);

  // MERGED (accounts + deposits), because both jobs below have to work for a
  // deposit leg: labelling the amount input with its currency, and — via
  // `currencyOf` — telling the schema which exponent to parse it with.
  const byId = useMemo(() => mergedAccountIndex(accounts, deposits), [accounts, deposits]);
  // Bound at render, not at submit: the exponent each amount parses with comes
  // from the account it belongs to, and an unknown id resolves to a field error
  // rather than a guessed exponent (AM-5).
  const currencyOf = useMemo(
    () => (accountId: string) => byId.get(accountId)?.currency,
    [byId],
  );

  // A leg can point at a deposit's HIDDEN ledger account, and in EDIT mode
  // nothing fixes the sides, so nothing used to stop that leg from rendering as
  // a picker. It cannot be one: the account is absent from `GET /accounts` by
  // design, so the box renders EMPTY — lying about where the money went — and
  // choosing any option in it would move the transfer off the deposit for good,
  // through a control the user reached while editing a note. Such a leg is
  // shown, exactly as it is shown when the deposit screen opens this form.
  const depositLeg = (accountId: string | null | undefined) =>
    accountId != null && accountId !== '' && byId.get(accountId)?.kind === 'deposit'
      ? accountId
      : undefined;
  const lockedSource =
    fixed?.side === 'source' ? fixed.accountId : depositLeg(transfer?.account_id);
  const lockedTarget =
    fixed?.side === 'target' ? fixed.accountId : depositLeg(transfer?.counter_account_id);

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
        // A fixed leg starts on ITS account; the free leg keeps the remembered
        // default. Both are ordinary RHF values — the fixed one is registered
        // like any other field (below), just not editable.
        account_id:
          fixed?.side === 'source'
            ? fixed.accountId
            : pickDefaultAccount(accounts, readLastAccountId()),
        counter_account_id: fixed?.side === 'target' ? fixed.accountId : '',
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
    setValue,
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

  // Legs denominated alike let the form fill the received amount in (see
  // `mirrorDecision`, which holds the whole rule and the reason it is a rule and
  // not a flag from the form library).
  const sentAmount = useWatch({ control, name: 'amount' });
  const counterAmount = useWatch({ control, name: 'counter_amount' });
  const sameCurrency =
    sourceCurrency !== undefined && sourceCurrency === targetCurrency;
  // The mirror's receipt: what it wrote last, and therefore the only value it
  // may overwrite. A ref rather than state — it renders nothing, it only
  // remembers.
  const mirrored = useRef<string | null>(null);

  useEffect(() => {
    const next = mirrorDecision({
      sameCurrency,
      sentAmount: sentAmount ?? '',
      counterAmount: counterAmount ?? '',
      mirrored: mirrored.current,
    });
    if (next === null) return;
    mirrored.current = next;
    setValue('counter_amount', next, { shouldDirty: false });
  }, [sameCurrency, sentAmount, counterAmount, setValue]);

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
            // goal-planner W2: read off the row rather than hardcoded `null`. A
            // transfer is not an expense and cannot be attached to a plan item
            // today, but asserting that here would be this file's OPINION about
            // another module's rule; echoing the stored value keeps it a fact.
            previousGoalItemId: transfer.goal_item_id,
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
        // Not when the SOURCE is the fixed leg: a withdrawal's source is a
        // deposit's hidden ledger, which no ordinary picker offers — remembering
        // it as "the account I used last" would be a preference nothing can
        // honour.
        if (fixed?.side !== 'source') rememberLastAccountId(values.account_id);
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
              : // Three fields this form does not render: a transfer has no
                // category, no merchant and (W2) no plan link. A code naming one
                // of them belongs at form level, not on a control that is absent.
                field === 'category_id' ||
                  field === 'merchant' ||
                  field === 'goal_item_id'
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
        previousGoalItemId: transfer.goal_item_id,
      });
      onClose();
    } catch (error) {
      setDeleteError(describeTransactionError(error, lang).message);
    }
  };

  if (confirmingDelete && transfer) {
    return (
      <ConfirmDialog
        title={t('transfer.deleteTitle')}
        // A1: one operation, one delete — both sides go, and both balances move
        // back. Saying so is what stops the user from hunting for the other half.
        message={t('transfer.deleteMessage')}
        confirmLabel={t('common.delete')}
        pendingLabel={t('common.deleting')}
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
  // With one leg fixed by the caller only the OTHER one has to be pickable, so
  // the floor drops from two accounts to one: a user whose only account is a
  // card must still be able to top up a deposit from it.
  const needed = fixed === undefined ? 2 : 1;
  const blocked =
    accountFieldBlocked(accountsPhase, accounts, transfer?.account_id) ||
    (!isEdit && usable < needed) ||
    // A locked leg's account is not in the merged list yet (deposits still
    // loading, or that read failed): its currency is unknown, so there is no
    // exponent to parse its amount with. The leg renders "Loading…" and Save
    // waits, rather than collecting an amount that resolves to a field error.
    [lockedSource, lockedTarget].some((id) => id !== undefined && byId.get(id) === undefined);

  return (
    <Modal
      title={t(
        isEdit
          ? 'transfer.editTitle'
          : fixed === undefined
            ? 'transfer.newTitle'
            : // The fixed leg says what this transfer IS: money INTO the deposit
              // is a top-up, money OUT of it a withdrawal.
              fixed.side === 'target'
              ? 'transfer.topUpTitle'
              : 'transfer.withdrawTitle',
      )}
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
        {accountsPhase === 'ready' && !isEdit && usable < needed ? (
          <p className={styles.notice} role="status">
            {t(fixed === undefined ? 'transfer.needTwoAccounts' : 'transfer.needOneAccount')}
          </p>
        ) : null}

        <Card size="sm" className={styles.leg}>
          {lockedSource !== undefined ? (
            <FixedLeg
              id="transfer-source"
              label={t('transfer.from')}
              hint={t(fixed === undefined ? 'transfer.depositLegHint' : 'transfer.fixedSideHint')}
              name={byId.get(lockedSource)?.name}
              currency={byId.get(lockedSource)?.currency}
              registration={sourceReg}
              errorMessage={errors.account_id?.message}
            />
          ) : (
            <AccountField
              id="transfer-source"
              label={t('transfer.from')}
              registration={sourceReg}
              accounts={accounts}
              phase={accountsPhase}
              onRetry={retryAccounts}
              currentId={transfer?.account_id}
              errorMessage={errors.account_id?.message}
            />
          )}

          <Field
            label={
              sourceCurrency
                ? t('transfer.amountSentIn', { currency: sourceCurrency })
                : t('transfer.amountSent')
            }
            htmlFor="transfer-amount"
            error={errors.amount?.message}
          >
            <Input
              id="transfer-amount"
              inputMode="decimal"
              className="tnum"
              aria-invalid={errors.amount ? true : undefined}
              {...register('amount')}
            />
          </Field>
        </Card>

        <p className={styles.arrow} aria-hidden="true">
          ↓
        </p>

        <Card size="sm" className={styles.leg}>
          {lockedTarget !== undefined ? (
            <FixedLeg
              id="transfer-target"
              label={t('transfer.to')}
              hint={t(fixed === undefined ? 'transfer.depositLegHint' : 'transfer.fixedSideHint')}
              name={byId.get(lockedTarget)?.name}
              currency={byId.get(lockedTarget)?.currency}
              registration={targetReg}
              errorMessage={errors.counter_account_id?.message}
            />
          ) : (
            <AccountField
              id="transfer-target"
              label={t('transfer.to')}
              registration={targetReg}
              accounts={accounts}
              phase={accountsPhase}
              onRetry={retryAccounts}
              currentId={transfer?.counter_account_id}
              errorMessage={errors.counter_account_id?.message}
            />
          )}

          <Field
            label={
              targetCurrency
                ? t('transfer.amountReceivedIn', { currency: targetCurrency })
                : t('transfer.amountReceived')
            }
            htmlFor="transfer-counter-amount"
            hint={t('transfer.receivedHint')}
            hintId="transfer-counter-amount-hint"
            error={errors.counter_amount?.message}
          >
            <Input
              id="transfer-counter-amount"
              inputMode="decimal"
              className="tnum"
              aria-invalid={errors.counter_amount ? true : undefined}
              aria-describedby="transfer-counter-amount-hint"
              {...register('counter_amount')}
            />
          </Field>
        </Card>

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
          <p className={`${styles.rate} tnum`} role="status">
            {/* `transfer_rate` is the SERVER's decimal string, interpolated
                verbatim — never parsed, rounded or recomputed. */}
            {t('transfer.rateAtTime', {
              rate: transfer.transfer_rate,
              counterCurrency: transfer.counter_currency ?? '',
              currency: transfer.currency,
            })}
          </p>
        ) : null}

        <Field label={t('common.date')} htmlFor="transfer-date" error={errors.occurred_at?.message}>
          <Input
            id="transfer-date"
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
          htmlFor="transfer-note"
          error={errors.note?.message}
        >
          <Textarea
            id="transfer-note"
            maxLength={500}
            aria-invalid={errors.note ? true : undefined}
            {...register('note')}
          />
        </Field>

        <div className={styles.actions}>
          {isEdit ? (
            <Button
              type="button"
              variant="ghost"
              className={styles.delete}
              onClick={() => {
                setDeleteError(undefined);
                setConfirmingDelete(true);
              }}
            >
              {t('common.delete')}
            </Button>
          ) : null}
          <span className={styles.spacer} />
          <Button type="submit" variant="primary" disabled={pending || blocked}>
            {t(pending ? 'common.saving' : 'common.save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * The leg the caller fixed: read-only TEXT plus a hidden input that keeps the
 * value REGISTERED with react-hook-form.
 *
 * Text rather than a disabled `<select>` — the AccountFormModal read-only
 * currency pattern — because a disabled control reads as "temporarily
 * unavailable", while this side is simply not a choice on this screen. And the
 * value has to stay registered: the schema validates `account_id` /
 * `counter_account_id`, and the submit handler reads them out of the form, so an
 * unregistered leg would submit as "".
 *
 * `name` is `undefined` only while the merged list is still loading (or failed);
 * the placeholder keeps the dialog's height stable instead of collapsing, and the
 * currency is shown beside the name for the same reason the picker shows it —
 * here it is also the exponent the amount below will be read at.
 */
function FixedLeg({
  id,
  label,
  hint,
  name,
  currency,
  registration,
  errorMessage,
}: {
  id: string;
  label: string;
  hint: string;
  name: string | undefined;
  currency: string | undefined;
  registration: UseFormRegisterReturn;
  errorMessage?: string;
}) {
  const t = useT();
  return (
    <div className={styles.field}>
      <span className={styles.label} id={`${id}-label`}>
        {label}
      </span>
      <p className={styles.readOnlyValue} aria-labelledby={`${id}-label`}>
        {name === undefined ? t('common.loading') : `${name} · ${currency ?? ''}`}
      </p>
      <input type="hidden" {...registration} />
      <p className={styles.hint}>{hint}</p>
      {errorMessage ? (
        <p className={styles.fieldError} role="alert">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
