// The 422s of the two-amount money model, mapped to MOBILE dictionary keys.
//
// The model itself lives in @budget/shared (`isPairMode`, `spendPrefill`,
// `spendCurrencyOptions`, `migrateAmounts`); this mapper does not, for the same
// reason web's does not: it names dictionary KEYS, and the two clients have
// disjoint key sets. The DECISIONS below are web's, verbatim.
//
// `FX_RATE_UNAVAILABLE` is the important one and it is NOT a form error: only six
// canonical currency pairs are stored (architecture §4), so "we have no rate for
// MXN->BYN on that date" is the NORMAL answer for an exotic pair, not a failure.
// The honest response is to stop asking the server to convert and let the user
// type what their bank actually took — which is what `needsManualCharge` switches
// the form into.
//
// Returns `null` for anything else, so the caller falls through to the shared
// `describeTransactionError` instead of this screen inventing a second opinion
// about codes it does not own.
//
// What it names is a KEY for three of the four codes and a ROLE for the fourth:
// FX_RATE_UNAVAILABLE's sentence tells the user what to type, and that is
// direction-dependent ("what your bank took" vs "what landed on the account", QA
// D-1). This module has no business knowing which kind the form is on, so it says
// `chargeNoRateAhead` and the screen resolves it through KIND_COPY.
import type { SimpleKey } from '../../i18n/t';
import type { KindCopy } from './kindCopy';

/**
 * The roles of KIND_COPY that always hold a key. `merchantHint` — the one entry
 * that may be null — is excluded by construction, so the caller never has to
 * handle a missing sentence.
 */
type KindCopyRole = {
  [K in keyof KindCopy]: KindCopy[K] extends SimpleKey ? K : never;
}[keyof KindCopy];

/** Either a plain dictionary key, or a role only the screen can resolve. */
export type OriginalPairMessage =
  | { kind: 'key'; key: SimpleKey }
  | { kind: 'kindCopy'; role: KindCopyRole };

export interface OriginalPairError {
  /** The form control the message belongs next to. */
  target: 'amount' | 'original_amount' | 'form';
  /** What to say; the screen renders it in whatever language is on screen. */
  message: OriginalPairMessage;
  /** Require the charged-amount field: the server cannot convert this pair. */
  needsManualCharge: boolean;
}

export function describeOriginalPairError(code: string | undefined): OriginalPairError | null {
  switch (code) {
    case 'FX_RATE_UNAVAILABLE':
      return {
        target: 'amount',
        // Deliberately NOT phrased as a failure: the copy explains that only six
        // pairs are stored and asks for the number the account actually saw (see
        // the two keys behind this role).
        message: { kind: 'kindCopy', role: 'chargeNoRateAhead' },
        needsManualCharge: true,
      };
    // The account was moved to one held in the very currency the operation was
    // spent in, so the pair no longer says anything ("50 EUR charged as 50 EUR").
    // The server refuses the whole PATCH; the way out is one tap, so name it.
    case 'ORIGINAL_CURRENCY_MATCHES_ACCOUNT':
      return {
        target: 'original_amount',
        message: { kind: 'key', key: 'txForm.pairCurrencyMatchesAccount' },
        needsManualCharge: false,
      };
    // Both are bug signals — the schema folds equality away and the patch builder
    // emits the pair atomically — but they are the two codes that would otherwise
    // land on the generic "something went wrong" while the user stares at two
    // amount fields, so they say which field is unaccounted for.
    case 'ORIGINAL_FIELDS_REQUIRED':
      return {
        target: 'original_amount',
        message: { kind: 'key', key: 'txForm.pairFieldsRequired' },
        needsManualCharge: false,
      };
    case 'AMOUNT_REQUIRED':
      return {
        target: 'amount',
        message: { kind: 'key', key: 'txForm.chargeRequired' },
        needsManualCharge: true,
      };
    default:
      return null;
  }
}
