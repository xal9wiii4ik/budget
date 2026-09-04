// The two-sided money model of one operation (transaction-details-and-i18n S1),
// pure so the decode discipline is vitest-pinned instead of living inside a
// form's JSX.
//
// Two amounts, two meanings, never mixed up:
//   SPENT   — `original_amount_minor` in `original_currency`: what the price tag
//             said (50 EUR).
//   CHARGED — `amount_minor` in the ACCOUNT's `currency`: what actually left the
//             account, the bank's own rate baked in (165 BYN). Balances, limits
//             and the base snapshot are all computed from THIS one
//             (architecture §1), which is why it is never derived on the client.
//
// When the two currencies are equal there is no pair at all: the server rejects
// equality (`ORIGINAL_CURRENCY_MATCHES_ACCOUNT`), and a form collapses to a
// single amount rather than surfacing that as an error the user has to decode.
//
// MOVED here from apps/web (mobile-catchup-2) for the reason `amountMirror` was:
// the mobile transaction form implements the same model, and a second copy of
// these four rules would drift the day one client's fix is not carried over.
// `describeOriginalPairError` did NOT come along — it names a client's own
// dictionary keys, so each client keeps its own.
import { SUPPORTED_CURRENCIES } from './currencies';
import { toInputString } from './money';

/**
 * The stored pair as it arrives on a row: both members or neither (DB CHECK).
 *
 * Declared STRUCTURALLY rather than as `Pick<TransactionRead, …>`: this package
 * is the one @budget/api-client depends on, not the other way round. Every
 * `TransactionRead` satisfies it, so call sites pass the row itself.
 */
export interface OriginalPair {
  amount_minor: number;
  currency: string;
  original_amount_minor: number | null;
  original_currency: string | null;
}

/** Is this operation denominated in a currency other than its account's? */
export function isPairMode(
  spendCurrency: string | undefined,
  accountCurrency: string,
): boolean {
  return spendCurrency !== undefined && spendCurrency !== accountCurrency;
}

export interface SpendPrefill {
  /** The "charged to the account" input, in the account's currency. */
  amount: string;
  /** The "spent" input, in `spendCurrency`. "" when there is no pair. */
  originalAmount: string;
  /** What the spend-currency control starts on: the pair's, else the account's. */
  spendCurrency: string;
}

/**
 * Edit-mode prefill for the two amount inputs.
 *
 * AM-5: each stored minor value is decoded with the currency IT is denominated
 * in — the charge with the row's `currency`, the spent amount with its own
 * `original_currency`. A 1000 JPY purchase on a EUR card must read "1000", not
 * "10.00", and that is exactly the mistake a single shared exponent would make.
 */
export function spendPrefill(tx: OriginalPair): SpendPrefill {
  const originalMinor = tx.original_amount_minor;
  const originalCurrency = tx.original_currency;
  const paired = originalMinor !== null && originalCurrency !== null;

  return {
    amount: toInputString(tx.amount_minor, tx.currency),
    originalAmount: paired ? toInputString(originalMinor, originalCurrency) : '',
    spendCurrency: paired ? originalCurrency : tx.currency,
  };
}

/**
 * What the spend-currency control suggests, in order: first the currencies that
 * are personally the user's — the account's own currency (the way BACK to a
 * single-amount operation, so it must always be reachable), then the currency of
 * the country on the user's profile, then every currency they already hold an
 * account in — and only then the rest of the TRACKED set, finally whatever is
 * currently selected if it is none of those.
 *
 * The tracked set belongs here even without a matching account: those are the
 * currencies rates exist for, and spending in one you hold no account in is the
 * ordinary case, not the exotic one (BYN-only accounts, a trip paid in EUR). Left
 * out, that user reaches for "other currency" on every single operation.
 *
 * A SUGGESTION list, not a whitelist (D7): the control accepts any well-formed
 * code, because the six canonical FX pairs are about rates, not about what a
 * person is allowed to have spent.
 */
export function spendCurrencyOptions(input: {
  accountCurrency: string;
  profileCurrency: string | null;
  accountCurrencies: readonly string[];
  current?: string;
}): string[] {
  const options: string[] = [];
  const add = (code: string | null | undefined) => {
    if (code && !options.includes(code)) options.push(code);
  };

  add(input.accountCurrency);
  add(input.profileCurrency);
  for (const code of input.accountCurrencies) add(code);
  for (const code of SUPPORTED_CURRENCIES) add(code);
  add(input.current);

  return options;
}

export interface AmountFields {
  /** The "charged to the account" input (account currency). "" = auto. */
  amount: string;
  /** The "spent" input (spend currency). "" when there is no pair. */
  originalAmount: string;
}

/**
 * What the two amount inputs hold after a form crosses between one-amount and
 * two-amount mode (a spend-currency pick, or an account move that changes the
 * account's currency).
 *
 * The rule is "the number the user is looking at stays where they are looking",
 * because the only field on screen in single mode and the leading field in pair
 * mode are the same slot to them:
 *
 *   single -> pair: the typed number was the operation's amount, so it becomes
 *     what was SPENT, and the charge goes back to automatic. (Typing 50 and then
 *     saying "that was euros" must not leave 50 sitting in a BYN field.)
 *   pair -> single: the CHARGE wins when there is one — it is what the account
 *     really lost, and the spent number is now unrepresentable. Only when no
 *     charge was ever entered does the spent number carry over, which is the
 *     create flow where the user just picked the currency back.
 *
 * No value is ever reinterpreted under a label that did not change with it, and
 * nothing here does arithmetic: strings move between fields, they are not
 * converted (D8 — only the server multiplies by a rate). Mobile relies on that
 * literally: the fields it moves hold the RAW typed string (F-1), still
 * unnormalized.
 */
export function migrateAmounts(
  fields: AmountFields,
  wasPair: boolean,
  isPair: boolean,
): AmountFields {
  if (wasPair === isPair) return fields;
  if (isPair) return { amount: '', originalAmount: fields.amount };
  return {
    amount: fields.amount === '' ? fields.originalAmount : fields.amount,
    originalAmount: '',
  };
}
