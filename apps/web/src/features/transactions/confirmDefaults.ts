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
 * `baseCurrency` is the profile base (the summary currency).
 */
export function buildConfirmDefaults(
  parsed: ParsedReceiptRead,
  suggestedCategoryId: string | null,
  categories: CategoryRead[],
  baseCurrency: string,
): MultiCurrencyTransactionFormInput {
  // Belt and braces: D6 already guarantees the server only ever suggests a
  // visible, non-archived category, but an id the picker cannot render must not
  // become the selected value — the <select> would silently show its first
  // option while the form state said something else.
  const suggested = suggestedCategoryId
    ? categories.find((category) => category.id === suggestedCategoryId && !category.archived)
    : undefined;

  return {
    amount: decodeParsedTotal(parsed.total_minor, parsed.currency),
    // NOT a decode fallback (amendment 2026-08-15 §2/§3): this picks which
    // currency the row IS, and a receipt that printed no currency is a
    // base-currency row. The user can correct it in the picker, which is fed
    // `extraCurrency={parsed.currency}` so an out-of-set code stays selectable.
    currency: parsed.currency ?? baseCurrency,
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
export function formatItemAmount(amount: string, currency: string | null): string {
  if (currency === null) return amount;
  const parsedAmount = parseMoney(amount, currency);
  if (!parsedAmount.ok) return amount;
  return formatMoney(parsedAmount.minor, currency);
}
