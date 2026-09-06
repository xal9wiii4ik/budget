// Mobile amount-input normalization (defect F-1).
//
// The shared money contract (`packages/shared` parseMoney / transactionFormSchema)
// accepts '.' as the ONLY decimal separator — that is a pinned decision and is not
// negotiable here. But iOS/Android render the `decimal-pad` keyboard with the
// separator key of the DEVICE locale: on a ru-RU device the only separator the user
// can type is ','. So "7,77" was rejected with "Enter a valid amount." and a Russian
// user had no way to enter kopecks at all.
//
// Fix at the mobile input boundary: normalize the typed value on its way into
// validation. The field keeps showing exactly what the user typed; only the value
// handed to the shared schema is normalized.
//
// RULE (deliberately narrow): exactly ONE separator character in the whole string —
// ',' or '.' — is the decimal point and is normalized to '.'. Anything with two or
// more separators is AMBIGUOUS ('1.234,56' is 1234.56 in ru but '1.234' + garbage in
// en; '7,,77' and '1,2,3' are simply malformed) and is passed through untouched so
// the shared parser rejects it. We never guess at thousands separators.

import { toInputString, toSignedInputString, type Lang } from '@budget/shared';

/** Normalize a typed amount so the shared '.'-only money parser can read it. */
export function normalizeAmountInput(raw: string): string {
  // Regex literal (not a module constant): a /g/ RegExp carries lastIndex state.
  if (raw.match(/[.,]/g)?.length !== 1) return raw;
  return raw.replace(',', '.');
}

// --- recurring / settings (catch-up 3, line B) -------------------------------
//
// The MIRROR of the rule above, on the way OUT (defect N-5 / catch-up-2 N-3).
//
// `toInputString` is the machine inverse of `parseMoney`: it always prints '.'
// (that is its contract, and it is shared with web, where '.' is also what the
// keyboard types). On a ru-RU phone the decimal-pad has no '.' key at all, so a
// prefilled "120.00" is a value the user cannot retype, cannot correct, and — if
// they clear and retype it — cannot reproduce. That is a mobile-only problem, so
// it is fixed at the mobile boundary rather than by making the shared helper
// locale-aware (which would drag web into it for no reason).
//
// The rule is deliberately the exact inverse of `normalizeAmountInput`: replace
// the ONE separator `toInputString` emitted, and only for 'ru'. Nothing else is
// touched — no grouping is inserted (a grouped string is not re-typable either,
// and `normalizeAmountInput` would refuse it), and the sign stays where it is.

/**
 * A machine amount string (`toInputString`'s output, or `spendPrefill`'s, which
 * is the same thing) written with the separator `lang`'s keyboard can type.
 *
 * Exported because two prefills already come out of `@budget/shared` as STRINGS
 * (`spendPrefill.amount` / `.originalAmount`), and re-deriving them from minor
 * units here would duplicate the pair rule instead of reusing it.
 */
export function localizeAmountString(machine: string, lang: Lang): string {
  return lang === 'ru' ? machine.replace('.', ',') : machine;
}

/**
 * Prefill string for a NON-NEGATIVE amount, written the way `lang`'s keyboard can
 * retype it. `normalizeAmountInput` maps it back on submit.
 */
export function toLocalInputString(minor: number, currency: string, lang: Lang): string {
  return localizeAmountString(toInputString(minor, currency), lang);
}

/**
 * The signed counterpart, for the one signed money field in the app (an
 * account's starting balance). Kept separate for the same reason the shared pair
 * is: everywhere else a negative minor is a bug, and `toInputString`'s RangeError
 * is the guard that catches it.
 */
export function toLocalSignedInputString(
  minor: number,
  currency: string,
  lang: Lang,
): string {
  return localizeAmountString(toSignedInputString(minor, currency), lang);
}
// --- end recurring / settings (catch-up 3, line B) ---------------------------
