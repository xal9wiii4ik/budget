// The 422s of the two-amount money model, mapped to WEB dictionary keys.
//
// The model itself — `isPairMode / spendPrefill / spendCurrencyOptions /
// migrateAmounts` — moved to @budget/shared (mobile-catchup-2) when the mobile
// transaction form grew the same two amounts; they are re-exported below so
// every call site in this feature keeps its import. What stayed is the ONE piece
// that cannot be shared: this mapper names dictionary keys, and the two clients
// have disjoint key sets.
import type { SimpleKey } from '../../i18n/t';

export {
  isPairMode,
  spendPrefill,
  spendCurrencyOptions,
  migrateAmounts,
} from '@budget/shared';
export type { AmountFields, SpendPrefill } from '@budget/shared';

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
  /**
   * A DICTIONARY KEY, not a sentence: this module stays pure and language-free,
   * and the form renders it with `t()` in whichever language is on screen. The
   * copy itself lives in `i18n/dict.*`.
   */
  messageKey: SimpleKey;
  /** Reveal + require the charged-amount field: the server cannot convert. */
  needsManualCharge: boolean;
}

export function describeOriginalPairError(code: string | undefined): OriginalPairError | null {
  switch (code) {
    case 'FX_RATE_UNAVAILABLE':
      return {
        target: 'amount',
        // Deliberately NOT phrased as a failure: the copy explains that only six
        // pairs are stored and asks for the bank's own number (see the key).
        messageKey: 'txForm.chargeNoRateAhead',
        needsManualCharge: true,
      };
    // The account was moved to one held in the very currency the operation was
    // spent in, so the pair no longer says anything ("50 EUR charged as 50 EUR").
    // The server refuses the whole PATCH; the way out is one click, so name it.
    case 'ORIGINAL_CURRENCY_MATCHES_ACCOUNT':
      return {
        target: 'original_amount',
        messageKey: 'txForm.pairCurrencyMatchesAccount',
        needsManualCharge: false,
      };
    // Both are bug signals — the schema folds equality away and the patch builder
    // emits the pair atomically — but they are the two codes that would otherwise
    // land on the generic "something went wrong" while the user stares at two
    // amount fields, so they say which field is unaccounted for.
    case 'ORIGINAL_FIELDS_REQUIRED':
      return {
        target: 'original_amount',
        messageKey: 'txForm.pairFieldsRequired',
        needsManualCharge: false,
      };
    case 'AMOUNT_REQUIRED':
      return {
        target: 'amount',
        messageKey: 'txForm.chargeRequired',
        needsManualCharge: true,
      };
    default:
      return null;
  }
}
