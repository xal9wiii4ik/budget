// The two-sided money model of one operation (transaction-details-and-i18n S1),
// pure so the decode discipline and the 422 fallbacks are vitest-pinned instead
// of living inside the form's JSX.
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
// equality (`ORIGINAL_CURRENCY_MATCHES_ACCOUNT`), and the form collapses to a
// single amount rather than surfacing that as an error the user has to decode.
import { toInputString } from '@budget/shared';
import type { components } from '@budget/api-client';

type TransactionRead = components['schemas']['TransactionRead'];

// The stored pair as it arrives on a row: both members or neither (DB CHECK).
type OriginalPair = Pick<
  TransactionRead,
  'amount_minor' | 'currency' | 'original_amount_minor' | 'original_currency'
>;

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
 * What the spend-currency control suggests, in order: the account's own currency
 * (the way BACK to a single-amount operation, so it must always be reachable),
 * then the currency of the country on the user's profile — the one they are most
 * likely spending in right now — then every currency they already hold an account
 * in, then whatever is currently selected if it is none of those.
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
 * What the two amount inputs hold after the form crosses between one-amount and
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
 * converted (D8 — only the server multiplies by a rate).
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

/**
 * The 422s that belong to the two-amount model, mapped where the user can act.
 *
 * `FX_RATE_UNAVAILABLE` is the important one and it is NOT a form error: only six
 * canonical currency pairs are stored (architecture §4), so "we have no rate for
 * MXN->BYN on that date" is the NORMAL answer for an exotic pair, not a failure.
 * The honest response is to stop asking the server to convert and let the user
 * type what their bank actually took — which is what `needsManualCharge` switches
 * the form into.
 *
 * Returns `null` for anything else, so the caller falls through to the shared
 * `describeTransactionError` instead of this feature inventing a second opinion
 * about codes it does not own.
 */
export interface OriginalPairError {
  /** The form control the message belongs next to. */
  target: 'amount' | 'original_amount' | 'form';
  message: string;
  /** Reveal + require the charged-amount field: the server cannot convert. */
  needsManualCharge: boolean;
}

export function describeOriginalPairError(code: string | undefined): OriginalPairError | null {
  switch (code) {
    case 'FX_RATE_UNAVAILABLE':
      return {
        target: 'amount',
        message:
          "We don't have an exchange rate for these two currencies on that date. Enter the amount your account was charged and save again.",
        needsManualCharge: true,
      };
    // The account was moved to one held in the very currency the operation was
    // spent in, so the pair no longer says anything ("50 EUR charged as 50 EUR").
    // The server refuses the whole PATCH; the way out is one click, so name it.
    case 'ORIGINAL_CURRENCY_MATCHES_ACCOUNT':
      return {
        target: 'original_amount',
        message:
          'This account is already in that currency. Set the spent currency back to the account currency to keep just one amount.',
        needsManualCharge: false,
      };
    // Both are bug signals — the schema folds equality away and the patch builder
    // emits the pair atomically — but they are the two codes that would otherwise
    // land on the generic "something went wrong" while the user stares at two
    // amount fields, so they say which field is unaccounted for.
    case 'ORIGINAL_FIELDS_REQUIRED':
      return {
        target: 'original_amount',
        message: 'Enter both what you spent and the currency you spent it in.',
        needsManualCharge: false,
      };
    case 'AMOUNT_REQUIRED':
      return {
        target: 'amount',
        message: 'Enter the amount your account was charged.',
        needsManualCharge: true,
      };
    default:
      return null;
  }
}
