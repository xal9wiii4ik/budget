// Receipt confirm mode (S6): the pure logic that turns a parsed receipt into the
// transaction form's starting values, plus the read-only items list's amount
// rendering. Pure and unit-tested because this is the seam where the receipt's
// numbers cross into a money form — the modal only decides WHEN to call it.
import {
  formatMoney,
  parseMoney,
  toInputString,
  toInputStringAtExponent,
  todayApiDate,
  type MultiCurrencyTransactionFormInput,
} from '@budget/shared';
import type { components } from '@budget/api-client';

import type { AccountRead } from '../../data/accounts';

type CategoryRead = components['schemas']['CategoryRead'];
type ParsedReceiptRead = components['schemas']['ParsedReceiptRead'];
type SuggestionSource = components['schemas']['SuggestionSource'];

/**
 * An uploaded receipt handed to `TransactionFormModal`. Two shapes, because the
 * flow really has two:
 *
 *   attach  (S5) — the photo is stored but was never read (saved without
 *                  scanning, or the read failed). Its ONLY effect is `receipt_id`
 *                  on the create body: no prefill, no confirm chrome.
 *   confirm (S6) — the photo was read. Same create mutation, but the form starts
 *                  from `buildConfirmDefaults` and also sends `merchant`.
 */
export type ReceiptAttachment =
  | { mode: 'attach'; id: string }
  | {
      mode: 'confirm';
      id: string;
      parsed: ParsedReceiptRead;
      suggestedCategoryId: string | null;
      suggestionSource: SuggestionSource | null;
    };

// AM-5 (binding). `parsed.total_minor` is encoded server-side at the PARSED
// currency's exponent, and a receipt with NO currency is encoded at the default
// exponent 2 (apps/api domain/money.py: `currency_exponent(None) -> 2`). It is
// therefore decoded the same way here.
const NO_CURRENCY_EXPONENT = 2;

/**
 * `total_minor` -> the amount input's string, decoded with the exponent it was
 * ENCODED with.
 *
 * AM-5: the null-currency arm is written out explicitly and NEVER routed through
 * `toInputString(minor, parsed.currency ?? baseCurrency)`. Under a base currency
 * whose exponent is not 2 (a JPY profile), that fallback would decode a
 * 12.50-euro-ish receipt total of 1250 as "1250" — a 100x lie.
 *
 * The honest consequence, which is NOT to be "fixed": a null-currency receipt
 * under a JPY base prefills "12.50" into a field the form validates as JPY, so it
 * reports "too many decimal places" until the user corrects the amount or picks
 * the real currency. Blanking the amount or decoding at the base exponent would
 * trade a visible, correctable complaint for a silent wrong number.
 */
export function decodeParsedTotal(totalMinor: number, currency: string | null): string {
  return currency === null
    ? toInputStringAtExponent(totalMinor, NO_CURRENCY_EXPONENT)
    : toInputString(totalMinor, currency);
}

/**
 * The confirm form's default values.
 *
 * `categories` is the archived-inclusive list the modal already holds;
 * `baseCurrency` is the profile base (the summary currency); `defaultAccount` is
 * the account the form starts on (features/accounts/lastAccount.ts), or
 * `undefined` when the user has none yet.
 *
 * accounts-and-transfers W1 (OQ-W2, first half): the row's currency is now the
 * ACCOUNT's, never the receipt's — the server enforces it (§4), so preselecting
 * the printed currency would only produce a 422. The parsed total is still
 * DECODED at the currency it was encoded with (below), so a EUR receipt confirmed
 * onto a BYN account prefills the printed number and the user corrects it, rather
 * than silently changing its magnitude. Naming that mismatch on screen is W2's
 * job; nothing here hides it.
 */
export function buildConfirmDefaults(
  parsed: ParsedReceiptRead,
  suggestedCategoryId: string | null,
  categories: CategoryRead[],
  baseCurrency: string,
  defaultAccount: { id: string; currency: string } | undefined,
): MultiCurrencyTransactionFormInput {
  // Belt and braces: D6 already guarantees the server only ever suggests a
  // visible, non-archived category, but an id the picker cannot render must not
  // become the selected value — the <select> would silently show its first
  // option while the form state said something else.
  const suggested = suggestedCategoryId
    ? categories.find((category) => category.id === suggestedCategoryId && !category.archived)
    : undefined;

  return {
    account_id: defaultAccount?.id ?? '',
    amount: decodeParsedTotal(parsed.total_minor, parsed.currency),
    // The currency the row WILL be in: its account's (§4). With no account yet
    // the form cannot be submitted at all, so the base currency stands in as the
    // amount field's exponent until one is picked — it is never sent.
    currency: defaultAccount?.currency ?? baseCurrency,
    // "" = auto. When the confirmed currency differs from the base, the form's
    // existing converted section fills this from the /fx/convert preview (WD-3)
    // and the server computes the stored snapshot itself.
    base_amount: '',
    // A receipt carries no kind (D10), so the suggested category's kind is the
    // only signal there is; without a suggestion, a receipt is a purchase.
    kind: suggested?.kind ?? 'expense',
    category_id: suggested?.id ?? '',
    occurred_at: parsed.date ?? todayApiDate(),
    // The line items get their own read-only list; the note stays the user's.
    note: '',
    merchant: parsed.merchant ?? '',
  };
}

/**
 * The account a receipt should be confirmed onto (OQ-W2, second half).
 *
 * The row's currency IS its account's (§4), so the closest thing to "record this
 * receipt as printed" is starting on an account already in the printed currency.
 * The rules, in order:
 *
 *   1. no currency was read      -> the usual default (nothing to match on);
 *   2. the usual default already
 *      matches the receipt        -> keep it (the user's own preference agrees);
 *   3. exactly ONE non-archived
 *      account in that currency   -> that one;
 *   4. several candidates         -> the usual default, and the mismatch warning
 *                                    tells the user to pick.
 *
 * Rule 4 refuses to guess for the same reason `pickDefaultAccount` stops at one
 * candidate: silently choosing between two EUR accounts puts money on the wrong
 * one, which is the failure this scope exists to prevent. Archived accounts are
 * never chosen — the form would not offer them as options.
 */
export function pickReceiptAccount(
  receiptCurrency: string | null,
  accounts: AccountRead[],
  fallbackId: string,
): string {
  if (receiptCurrency === null) return fallbackId;

  const matching = accounts.filter(
    (account) => !account.archived && account.currency === receiptCurrency,
  );
  if (matching.some((account) => account.id === fallbackId)) return fallbackId;
  return matching.length === 1 ? matching[0].id : fallbackId;
}

export interface ReceiptCurrencyMismatch {
  receiptCurrency: string;
  accountCurrency: string;
}

/**
 * The two currencies to name out loud when the receipt and the chosen account
 * disagree — "this receipt is in EUR, this account is in BYN".
 *
 * `null` (nothing to say) covers three cases that are NOT mismatches: a receipt
 * whose currency was not read, no account picked yet, and the currencies
 * agreeing. Saving is still allowed while this warning is up: the server stamps
 * the account's currency (§4) and the amount stays whatever the user typed, so
 * this is a "check the number" notice, not a validation error.
 */
export function receiptCurrencyMismatch(
  receiptCurrency: string | null,
  accountCurrency: string | undefined,
): ReceiptCurrencyMismatch | null {
  if (receiptCurrency === null || accountCurrency === undefined) return null;
  if (receiptCurrency === accountCurrency) return null;
  return { receiptCurrency, accountCurrency };
}

/**
 * How one parsed line item's amount renders.
 *
 * `ReceiptItem.amount` is a decimal string exactly as printed — NOT minor units,
 * and (unlike `total`, which AM-2 validates) never checked server-side. So:
 *   - with a parsed currency: re-encode at THAT currency's exponent and format it
 *     locale-aware, so "12.50"/USD reads as $12.50 and "1250"/JPY as ¥1,250;
 *   - without one: render the string verbatim. There is no currency to attach a
 *     symbol to, and borrowing the base currency's would both mislabel the money
 *     and (AM-5) re-encode it at the wrong exponent;
 *   - dirty model output ("about 12,50"): verbatim too — showing what the receipt
 *     said beats showing NaN or dropping the line.
 *
 * `parsed.currency` is either null or `^[A-Z]{3}$` (the server's ParsedReceipt
 * validator coerces anything else to null), so `formatMoney`'s code assertion
 * cannot fire here.
 */
export function formatItemAmount(
  amount: string,
  currency: string | null,
  locale?: string,
): string {
  if (currency === null) return amount;
  const parsedAmount = parseMoney(amount, currency);
  if (!parsedAmount.ok) return amount;
  return formatMoney(parsedAmount.minor, currency, { locale });
}
