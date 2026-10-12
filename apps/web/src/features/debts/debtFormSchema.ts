import { parseMoney, type MoneyParseError } from '@budget/shared';
import { z } from 'zod';

import type { Translate } from '../../i18n/t';
import type { DebtDirection } from '../../data/debts';

/**
 * The debt form's schema (create and edit).
 *
 * Web-local, like `depositFormSchema` / `tokenFormSchema` and for the same
 * senior-lead ruling: the shared schemas exist because TWO clients validate the
 * same form, and apps/mobile is frozen with no debts screen. A factory over `t`
 * because the messages are user-facing copy and must follow the chosen language.
 *
 * Three server rules are mirrored here so a 422 is a bug signal rather than the
 * normal way to learn you typed something wrong (architecture §Currency,
 * §Write bodies):
 *
 *  * ONE rule for the second amount. A movement carries `amount_minor` in the
 *    DEBT currency and `account_amount_minor` in the ACCOUNT currency. When the
 *    two currencies differ, the account figure is REQUIRED from the user (their
 *    real rate, never ours — `DEBT_ACCOUNT_AMOUNT_REQUIRED`); when they are
 *    equal the server copies and a value sent anyway is refused
 *    (`DEBT_ACCOUNT_AMOUNT_NOT_APPLICABLE`), so this schema resolves it to
 *    `null` and the builders emit no key.
 *  * Both amounts are positive magnitudes (the CHECK `debt_amounts_positive`),
 *    so a parsed zero is rejected HERE rather than as a 500-shaped surprise.
 *  * `due_on` may not precede `opened_on` (`DEBT_DUE_BEFORE_OPENING`). Two
 *    "YYYY-MM-DD" strings compare as dates, so nothing is parsed.
 *
 * The currency each amount is parsed with is bound at VALIDATION time: the debt
 * currency is a field of this very form on create, and the account currency is
 * resolved through the `currencyOf` lookup the host passes in — an unknown
 * account id resolves to a field error, never to a guessed exponent (AM-5).
 */

export interface DebtFormValues {
  /** Create-only on the wire; immutable server-side. */
  direction: DebtDirection;
  counterparty: string;
  /** Create-only on the wire; immutable server-side. */
  currency: string;
  /** In the DEBT currency. */
  amount_minor: number;
  account_id: string;
  /** In the ACCOUNT currency, or `null` when the two currencies are the same. */
  account_amount_minor: number | null;
  opened_on: string;
  due_on: string | null;
  note: string | null;
}

export const DEBT_COUNTERPARTY_MAX = 100;
export const DEBT_NOTE_MAX = 500;

const MONEY_MESSAGE_KEY = {
  empty: 'debtForm.error.amountRequired',
  malformed: 'debtForm.error.amountMalformed',
  negative: 'debtForm.error.amountNegative',
  'too-many-decimals': 'debtForm.error.amountDecimals',
  overflow: 'debtForm.error.amountOverflow',
} as const satisfies Record<MoneyParseError, string>;

/**
 * Parses one money field at `currency` and reports through `ctx`. Returns the
 * minor units, or `null` when it could not be read (the caller then bails).
 *
 * A zero is refused on purpose: both CHECKs on a debt movement require a
 * positive magnitude, and "0" in an amount box is a typo, not an intent.
 */
function readAmount(
  raw: string,
  currency: string,
  path: string,
  t: Translate,
  ctx: z.RefinementCtx,
): number | null {
  const parsed = parseMoney(raw, currency);
  if (!parsed.ok) {
    ctx.addIssue({
      code: 'custom',
      path: [path],
      params: { reason: parsed.error },
      message: t(MONEY_MESSAGE_KEY[parsed.error], { currency }),
    });
    return null;
  }
  if (parsed.minor <= 0) {
    ctx.addIssue({
      code: 'custom',
      path: [path],
      message: t('debtForm.error.amountPositive'),
    });
    return null;
  }
  return parsed.minor;
}

/**
 * `currencyOf` resolves an account id to the currency it is denominated in
 * (the transfer form's lookup, built from the cached account list).
 */
export function debtFormSchema(t: Translate, currencyOf: (accountId: string) => string | undefined) {
  return z
    .object({
      direction: z.enum(['lent', 'borrowed']),
      counterparty: z
        .string()
        .trim()
        .min(1, { error: t('debtForm.error.counterpartyRequired') })
        .max(DEBT_COUNTERPARTY_MAX, {
          error: t('debtForm.error.counterpartyTooLong', { max: DEBT_COUNTERPARTY_MAX }),
        }),
      currency: z.string(),
      amount: z.string(),
      account_id: z.string().min(1, { error: t('debtForm.error.accountRequired') }),
      account_amount: z.string(),
      opened_on: z.string().min(1, { error: t('debtForm.error.dateRequired') }),
      due_on: z.string(),
      note: z.string().max(DEBT_NOTE_MAX, { error: t('debtForm.error.noteTooLong') }),
    })
    .transform((values, ctx): DebtFormValues | typeof z.NEVER => {
      let failed = false;

      const amountMinor = readAmount(values.amount, values.currency, 'amount', t, ctx);
      if (amountMinor === null) failed = true;

      // The account's own currency decides BOTH whether a second amount exists
      // and which exponent it is read at. `undefined` = the list does not know
      // this id (still loading, failed, or a stale screen): refused on the
      // picker rather than parsed at a guessed exponent.
      const accountCurrency = values.account_id === '' ? undefined : currencyOf(values.account_id);
      if (values.account_id !== '' && accountCurrency === undefined) {
        failed = true;
        ctx.addIssue({
          code: 'custom',
          path: ['account_id'],
          message: t('debtForm.error.accountUnknown'),
        });
      }

      let accountAmountMinor: number | null = null;
      if (accountCurrency !== undefined && accountCurrency !== values.currency) {
        const parsed = readAmount(
          values.account_amount,
          accountCurrency,
          'account_amount',
          t,
          ctx,
        );
        if (parsed === null) failed = true;
        else accountAmountMinor = parsed;
      }
      // Same currency: whatever is in that (hidden) box is dropped — the server
      // copies `amount_minor` and refuses a disagreeing value.

      const dueOn = values.due_on.trim() === '' ? null : values.due_on;
      if (dueOn !== null && values.opened_on !== '' && dueOn < values.opened_on) {
        failed = true;
        ctx.addIssue({
          code: 'custom',
          path: ['due_on'],
          message: t('debtForm.error.dueBeforeOpening'),
        });
      }

      if (failed || amountMinor === null) return z.NEVER;

      return {
        direction: values.direction,
        counterparty: values.counterparty,
        currency: values.currency,
        amount_minor: amountMinor,
        account_id: values.account_id,
        account_amount_minor: accountAmountMinor,
        opened_on: values.opened_on,
        due_on: dueOn,
        note: values.note.trim() === '' ? null : values.note.trim(),
      };
    });
}

export type DebtFormInput = z.input<ReturnType<typeof debtFormSchema>>;

// --- one repayment --------------------------------------------------------

export interface RepaymentFormValues {
  /** In the DEBT currency — what the counterparty counts as repaid. */
  amount_minor: number;
  account_id: string;
  /** In the ACCOUNT currency, or `null` when the two currencies are the same. */
  account_amount_minor: number | null;
  occurred_at: string;
  note: string | null;
}

/**
 * The repayment form's schema. It lives beside the debt schema above because it
 * mirrors the SAME two currency rules on the same two fields (architecture: "ONE
 * rule for every movement") and shares its money reader — two copies of that
 * rule is exactly how one of them would drift.
 *
 * The debt currency is a CONSTRUCTION parameter, not a field: a repayment is
 * always denominated in the debt's own currency, which is immutable server-side.
 * The remaining-amount ceiling is deliberately NOT checked here: it is server
 * state under a row lock (`DEBT_REPAYMENT_EXCEEDS_REMAINING`), and a client copy
 * of it would be a second opinion about money that can change in another tab.
 */
export function repaymentFormSchema(
  t: Translate,
  debtCurrency: string,
  currencyOf: (accountId: string) => string | undefined,
) {
  return z
    .object({
      amount: z.string(),
      account_id: z.string().min(1, { error: t('debtForm.error.accountRequired') }),
      account_amount: z.string(),
      occurred_at: z.string().min(1, { error: t('debtForm.error.dateRequired') }),
      note: z.string().max(DEBT_NOTE_MAX, { error: t('debtForm.error.noteTooLong') }),
    })
    .transform((values, ctx): RepaymentFormValues | typeof z.NEVER => {
      let failed = false;

      const amountMinor = readAmount(values.amount, debtCurrency, 'amount', t, ctx);
      if (amountMinor === null) failed = true;

      const accountCurrency = values.account_id === '' ? undefined : currencyOf(values.account_id);
      if (values.account_id !== '' && accountCurrency === undefined) {
        failed = true;
        ctx.addIssue({
          code: 'custom',
          path: ['account_id'],
          message: t('debtForm.error.accountUnknown'),
        });
      }

      let accountAmountMinor: number | null = null;
      if (accountCurrency !== undefined && accountCurrency !== debtCurrency) {
        const parsed = readAmount(values.account_amount, accountCurrency, 'account_amount', t, ctx);
        if (parsed === null) failed = true;
        else accountAmountMinor = parsed;
      }

      if (failed || amountMinor === null) return z.NEVER;

      return {
        amount_minor: amountMinor,
        account_id: values.account_id,
        account_amount_minor: accountAmountMinor,
        occurred_at: values.occurred_at,
        note: values.note.trim() === '' ? null : values.note.trim(),
      };
    });
}

export type RepaymentFormInput = z.input<ReturnType<typeof repaymentFormSchema>>;
