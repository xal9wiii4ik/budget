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

/** Normalize a typed amount so the shared '.'-only money parser can read it. */
export function normalizeAmountInput(raw: string): string {
  // Regex literal (not a module constant): a /g/ RegExp carries lastIndex state.
  if (raw.match(/[.,]/g)?.length !== 1) return raw;
  return raw.replace(',', '.');
}
