// The "+" shortcut (recurring-book-now W1): the pure logic that turns a recurring
// TEMPLATE into the transaction form's starting values.
//
// This is a DRAFT of an ordinary operation, not a charge (R1/R6): nothing here
// materializes a due date, moves the watermark or stamps `recurring_template_id`
// — the user edits what they want and saves through the same POST /transactions
// as any other row. It is pure and unit-tested for the same reason
// `confirmDefaults.ts` is: this is the seam where a stored money amount crosses
// into a money form, and a wrong exponent here is a 100x error nobody sees.
import { toInputString, type MultiCurrencyTransactionFormInput } from '@budget/shared';
import type { components } from '@budget/api-client';

type TransactionKind = components['schemas']['TransactionKind'];

/**
 * What the prefill needs to know, and nothing more.
 *
 * Structural on purpose: BOTH entry points satisfy it without a cast or a second
 * mapper — `RecurringTemplateRead` (the /recurring row) fully, and
 * `UpcomingChargeRead` (the widget row) with `merchant`/`note` simply absent,
 * which is the honest shape of that endpoint's payload rather than a fabricated
 * empty string.
 */
export interface TemplatePrefillSource {
  account_id: string;
  amount_minor: number;
  currency: string;
  kind: TransactionKind;
  category_id: string | null;
  name: string;
  merchant?: string | null;
  note?: string | null;
}

/**
 * The form's starting values for a shortcut create.
 *
 * `occurredAt` is INJECTED because the two entry points disagree about it by
 * decision (R4): the widget passes the row's own `due_on` (the click landed on a
 * dated charge), the /recurring list passes `todayApiDate()` (no date is in
 * focus and the shortcut means "record this now"). Keeping it out of here also
 * keeps this module clock-free.
 *
 * The amount is decoded with the TEMPLATE's own currency, which is its account's
 * (architecture §4) — the same currency the form will parse the field back with,
 * so a JPY template prefills "5000" and not "50.00" (AM-5). No arithmetic, no
 * toFixed, no ×100.
 */
export function buildTemplateDefaults(
  source: TemplatePrefillSource,
  occurredAt: string,
): MultiCurrencyTransactionFormInput {
  return {
    account_id: source.account_id,
    amount: toInputString(source.amount_minor, source.currency),
    // The currency the row will be saved in: its account's (§4). The template is
    // stamped with exactly that one, so this is a fact, not a fallback — and it
    // is also the exponent the amount field is parsed with.
    currency: source.currency,
    // One amount, no pair: the spend currency equals the account's. The user can
    // still change it — this is an ordinary create form.
    original_currency: source.currency,
    original_amount: '',
    // "" = auto: when the template's currency differs from the profile base, the
    // form's own converted section fills this from the /fx/convert preview and
    // the server computes the stored snapshot. The client never multiplies by a
    // rate (D8).
    base_amount: '',
    // A template is never a transfer (the transfer form is its own, A1), so the
    // narrow to what this form's radios can represent is a fact — the same one
    // `editDefaults` makes.
    kind: source.kind === 'income' ? 'income' : 'expense',
    category_id: source.category_id ?? '',
    occurred_at: occurredAt,
    note: source.note ?? '',
    // The template's merchant, or its NAME when it has none. A deliberate
    // divergence from the nightly job (which copies `merchant` only): a manual
    // row carries no `recurring_template_id`, so it gets no "Recurring" badge to
    // resolve the template's name from — "Rent" would be lost entirely. R3 asks
    // for "merchant/name"; the field is editable.
    merchant: source.merchant ?? source.name,
  };
}
