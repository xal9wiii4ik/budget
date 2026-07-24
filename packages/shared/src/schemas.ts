import { z } from 'zod';
import { CURRENCY_CODE_PATTERN } from './currencies';
import { parseMoney, type MoneyParseError } from './money';

// Shape validation for an ISO-4217 currency code (alpha-3, uppercase).
export const currencyCodeSchema = z.string().regex(CURRENCY_CODE_PATTERN);

// Internal English default messages (plan AM4). NOT exported: clients map/override
// messages via the issue's `params.reason` (the MoneyParseError code) for i18n.
// The contract clients depend on is `params.reason`, not this text.
const MONEY_ERROR_MESSAGES: Record<MoneyParseError, string> = {
  empty: 'Enter an amount.',
  malformed: 'Enter a valid amount.',
  negative: 'Amount must not be negative.',
  'too-many-decimals': 'Too many decimal places for this currency.',
  overflow: 'Amount is too large.',
};

// Factory: fixed-currency amount field. string "12.50" -> number 1250 (minor
// units), with per-currency exponent validation surfaced as a zod issue whose
// `params.reason` is the MoneyParseError code (plan D8 + AM4).
export function moneyAmountSchema(currency: string) {
  return z.string().transform((raw, ctx) => {
    const result = parseMoney(raw, currency);
    if (!result.ok) {
      ctx.addIssue({
        code: 'custom',
        params: { reason: result.error },
        message: MONEY_ERROR_MESSAGES[result.error],
      });
      return z.NEVER;
    }
    return result.minor;
  });
}
