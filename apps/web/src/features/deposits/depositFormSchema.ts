import { parseMoney, type MoneyParseError } from '@budget/shared';
import { z } from 'zod';

import type { DepositCapitalization } from '../../data/deposits';
import type { Translate } from '../../i18n/t';

/**
 * The deposit form's schema.
 *
 * It lives beside the feature rather than in `@budget/shared` for the
 * `tokenFormSchema` / `incomeFormSchema` reason (senior-lead ruling): the shared
 * schemas exist because TWO clients validate the same form, and there is no
 * second consumer — apps/mobile is frozen and has no deposits screen. It is a
 * factory over `t` for the same reason those are: the messages are user-facing
 * copy and must follow the chosen language.
 *
 * Two rules shape it, both mirroring the server so a 422 is a bug signal rather
 * than the normal way to learn you typed something wrong:
 *
 *  * RATES STAY STRINGS. `rate_percent` and `tax_rate_percent` are `Decimal`
 *    columns and cross the wire as decimal strings (the `transfer_rate`
 *    precedent). Parsing "10.95" into a JS number and sending 10.949999999999999
 *    is precisely what that contract exists to prevent, so this file validates
 *    the DIGITS and passes the trimmed string through untouched. Bounds are
 *    checked on the digit string too (`Numeric(8,4)` / `Numeric(5,2)`, tax
 *    0..100), never through a float comparison.
 *  * THE OPENING BODY IS MONEY. `initial_balance` goes through the shared
 *    `parseMoney` at the SELECTED currency — hence an object-level transform
 *    (the `multiCurrencyTransactionFormSchema` technique): the currency is a
 *    field of this very form on create, so a per-field factory could not see it.
 *    Blank means zero, which is the server's default and the ordinary case for a
 *    deposit opened after the user started keeping books.
 *
 * The dates are compared here as well (`term_end` must be strictly after
 * `opened_on`) so `DEPOSIT_TERM_BEFORE_OPENING` is unreachable from a correct
 * client. Two "YYYY-MM-DD" strings compare as dates, so nothing is parsed.
 */

export interface DepositFormValues {
  name: string;
  currency: string;
  /** A decimal STRING, wire-ready. Never a number — see above. */
  rate_percent: string;
  capitalization: DepositCapitalization;
  opened_on: string;
  /** `null` = open-ended (a savings account). */
  term_end: string | null;
  /** `null` = not taxed, which is NOT the same as a rate of zero. */
  tax_rate_percent: string | null;
  /** Create-only; the edit form never renders it (see DepositFormModal). */
  initial_balance_minor: number;
}

export const DEPOSIT_NAME_MAX = 100;

// A bare non-negative decimal. No sign, no exponent, no separator but '.' — the
// same shape `parseMoney` accepts, minus the bare-fraction forms, because a rate
// is written "10.95" and never ".95".
const PERCENT_PATTERN = /^\d+(?:\.\d+)?$/;

type PercentError = 'malformed' | 'tooManyDecimals' | 'tooLarge';

interface PercentLimits {
  /** Digits before the point, from the column's precision/scale. */
  maxIntegerDigits: number;
  maxDecimals: number;
  /** An extra ceiling the column alone does not express (tax: 0..100). */
  ceiling?: number;
}

/**
 * Validates the digits of a percent and returns the string VERBATIM (trimmed).
 * Never `Number()`s it: the value it guards is a Decimal on both ends of the
 * wire, and the one place a float could sneak in is a bounds check — so the
 * ceiling is compared on the digits too (integer part below the ceiling, or
 * exactly the ceiling with an all-zero fraction).
 */
function parsePercent(
  raw: string,
  limits: PercentLimits,
): { ok: true; value: string } | { ok: false; error: PercentError } {
  const value = raw.trim();
  if (!PERCENT_PATTERN.test(value)) return { ok: false, error: 'malformed' };

  const [intPart, fracPart = ''] = value.split('.');
  if (fracPart.length > limits.maxDecimals) return { ok: false, error: 'tooManyDecimals' };

  // Leading zeros are legal input ("007.5") and must not count against the
  // column's precision.
  const digits = intPart.replace(/^0+(?=\d)/, '');
  if (digits.length > limits.maxIntegerDigits) return { ok: false, error: 'tooLarge' };

  if (limits.ceiling !== undefined) {
    const ceiling = String(limits.ceiling);
    const overCeiling =
      digits.length > ceiling.length ||
      (digits.length === ceiling.length && digits > ceiling) ||
      (digits === ceiling && /[1-9]/.test(fracPart));
    if (overCeiling) return { ok: false, error: 'tooLarge' };
  }

  return { ok: true, value };
}

const RATE_LIMITS: PercentLimits = { maxIntegerDigits: 4, maxDecimals: 4 };
const TAX_LIMITS: PercentLimits = { maxIntegerDigits: 3, maxDecimals: 2, ceiling: 100 };

const MONEY_MESSAGE_KEY = {
  malformed: 'depositForm.error.amountMalformed',
  negative: 'depositForm.error.amountNegative',
  'too-many-decimals': 'depositForm.error.amountDecimals',
  overflow: 'depositForm.error.amountOverflow',
  // Unreachable: a blank opening body short-circuits to 0 below. Mapped anyway
  // so the record stays total over MoneyParseError and a new code fails
  // typecheck instead of falling through.
  empty: 'depositForm.error.amountMalformed',
} as const satisfies Record<MoneyParseError, string>;

const RATE_MESSAGE_KEY = {
  malformed: 'depositForm.error.rateMalformed',
  tooManyDecimals: 'depositForm.error.rateDecimals',
  tooLarge: 'depositForm.error.rateTooLarge',
} as const satisfies Record<PercentError, string>;

const TAX_MESSAGE_KEY = {
  malformed: 'depositForm.error.taxMalformed',
  tooManyDecimals: 'depositForm.error.taxDecimals',
  tooLarge: 'depositForm.error.taxTooLarge',
} as const satisfies Record<PercentError, string>;

export function depositFormSchema(t: Translate) {
  return z
    .object({
      name: z
        .string()
        .trim()
        .min(1, { error: t('depositForm.error.nameRequired') })
        .max(DEPOSIT_NAME_MAX, {
          error: t('depositForm.error.nameTooLong', { max: DEPOSIT_NAME_MAX }),
        }),
      currency: z.string(),
      rate: z.string(),
      capitalization: z.enum(['none', 'monthly', 'quarterly', 'at_maturity']),
      opened_on: z.string().min(1, { error: t('depositForm.error.openedOnRequired') }),
      term_end: z.string(),
      tax_rate: z.string(),
      initial_balance: z.string(),
    })
    .transform((values, ctx): DepositFormValues | typeof z.NEVER => {
      let failed = false;

      const rate = parsePercent(values.rate, RATE_LIMITS);
      if (!rate.ok) {
        failed = true;
        ctx.addIssue({
          code: 'custom',
          path: ['rate'],
          message: t(RATE_MESSAGE_KEY[rate.error]),
        });
      }

      // "" is the "not taxed" sentinel, and it is NOT an error: most deposits
      // here are not taxed, and null is what clears the column server-side.
      let taxRate: string | null = null;
      if (values.tax_rate.trim() !== '') {
        const parsed = parsePercent(values.tax_rate, TAX_LIMITS);
        if (parsed.ok) {
          taxRate = parsed.value;
        } else {
          failed = true;
          ctx.addIssue({
            code: 'custom',
            path: ['tax_rate'],
            message: t(TAX_MESSAGE_KEY[parsed.error]),
          });
        }
      }

      // "" = open-ended. A term that does not end AFTER the day it started is
      // the server's DEPOSIT_TERM_BEFORE_OPENING, caught here first.
      const termEnd = values.term_end.trim() === '' ? null : values.term_end;
      if (termEnd !== null && values.opened_on !== '' && termEnd <= values.opened_on) {
        failed = true;
        ctx.addIssue({
          code: 'custom',
          path: ['term_end'],
          message: t('depositForm.error.termBeforeOpening'),
        });
      }

      // Blank = 0: the deposit was opened inside the app and starts empty until
      // the first transfer lands on it.
      let initialBalanceMinor = 0;
      if (values.initial_balance.trim() !== '') {
        const parsed = parseMoney(values.initial_balance, values.currency);
        if (parsed.ok) {
          initialBalanceMinor = parsed.minor;
        } else {
          failed = true;
          ctx.addIssue({
            code: 'custom',
            path: ['initial_balance'],
            params: { reason: parsed.error },
            message: t(MONEY_MESSAGE_KEY[parsed.error], { currency: values.currency }),
          });
        }
      }

      if (failed || !rate.ok) return z.NEVER;

      return {
        name: values.name,
        currency: values.currency,
        rate_percent: rate.value,
        capitalization: values.capitalization,
        opened_on: values.opened_on,
        term_end: termEnd,
        tax_rate_percent: taxRate,
        initial_balance_minor: initialBalanceMinor,
      };
    });
}

export type DepositFormInput = z.input<ReturnType<typeof depositFormSchema>>;
