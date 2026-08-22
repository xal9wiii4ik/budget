// The converted-section wire semantics (requirement 3 / WD-3), extracted as pure
// functions so the omitted / null / value trichotomy is vitest-pinned instead of
// living in JSX event handlers. The modal only decides WHEN to call these.
//
// One representation, three intents. The form field `base_amount` carries "" for
// "automatic — let the server compute"; the shared schema folds that to
// `base_amount_minor: null`. From there:
//
//   CREATE: the key is sent ONLY when a human actually typed in the field
//           (`baseAmountEdited`). An autofilled-but-untouched preview value is
//           OMITTED and the server computes the snapshot itself at the same
//           stored rate — a debounced preview can be stale at submit time, and
//           storing a stale echo as "the user's override" is a silent lie. The
//           field is labelled an estimate; the server delivers the exact number.
//   PATCH:  buildTransactionPatch (@budget/api-client) diffs against the stored
//           snapshot: unchanged -> omit, value -> number, cleared -> null
//           (discard the override, recompute).
import { toInputString } from '@budget/shared';
import type { MultiCurrencyTransactionFormValues } from '@budget/shared';
import { emptyToNull, type components } from '@budget/api-client';

type FxConvertRead = components['schemas']['FxConvertRead'];
type TransactionCreate = components['schemas']['TransactionCreate'];
type TransactionRead = components['schemas']['TransactionRead'];

// The snapshot pair as it arrives on a row: both members or neither (the DB CHECK
// constraint keeps them atomic, which is what makes the AM-5 decode below safe).
type SnapshotPair = Pick<TransactionRead, 'base_amount_minor' | 'base_currency'>;

/** D8: the section exists only while the row is denominated in a foreign currency. */
export function shouldShowConvertedSection(currency: string, baseCurrency: string): boolean {
  return currency !== baseCurrency;
}

/**
 * What an UNTOUCHED converted field must display for a given preview result
 * (create mode only; the caller guards on `baseAmountEdited`, so a value a human
 * typed never reaches here).
 *
 * The null triple — no rate for this pair/date — returns "", which CLEARS an
 * earlier autofill. Keeping the old number would put an amount on screen that the
 * server will not store: an untouched value is omitted from the create body
 * (`buildCreateBody`) and the row is saved with a NULL snapshot.
 */
export function previewAutofillValue(preview: FxConvertRead): string {
  if (preview.converted_minor === null) return '';
  // AM-5: decode with the `to` currency the server echoed — the currency this
  // number is denominated in.
  return toInputString(preview.converted_minor, preview.to);
}

/**
 * POST /transactions body. `base_amount_minor` is included only for a foreign row
 * whose converted field a human edited to a parseable value.
 *
 * accounts-and-transfers W1: `account_id` is required, and `currency` is NOT sent
 * at all — the server stamps it from the account (architecture §4), and a client
 * copy could only ever agree (redundant) or disagree (422
 * ACCOUNT_CURRENCY_MISMATCH). The form's `values.currency` is still the currency
 * this row WILL have, which is what decides the base-amount rules below.
 */
export function buildCreateBody(
  values: MultiCurrencyTransactionFormValues,
  baseCurrency: string,
  baseAmountEdited: boolean,
): TransactionCreate {
  const body: TransactionCreate = {
    account_id: values.account_id,
    kind: values.kind,
    category_id: emptyToNull(values.category_id),
    occurred_at: values.occurred_at,
    note: emptyToNull(values.note),
  };

  // transaction-details-and-i18n S1: what the account was CHARGED. `null` is not
  // a value to send — `amount_minor` is NOT NULL server-side — it is the user
  // saying "you work it out from what I spent", which the server does exactly
  // when this key is absent and the original pair is present (architecture §3,
  // create row 4). The schema only allows it in that paired case.
  if (values.amount !== null) body.amount_minor = values.amount;

  // The pair travels together or not at all (the server 422s half of it), and it
  // never carries the account's own currency: the schema already folded that
  // case to "no pair", so `ORIGINAL_CURRENCY_MATCHES_ACCOUNT` is unreachable
  // from this body.
  const originalMinor = values.original_amount_minor ?? null;
  const originalCurrency = values.original_currency ?? null;
  if (originalMinor !== null && originalCurrency !== null) {
    body.original_amount_minor = originalMinor;
    body.original_currency = originalCurrency;
  }

  // S2: "" (not set) -> null, the note/category_id bridge.
  if (values.country !== undefined) body.country = emptyToNull(values.country);

  if (
    values.currency !== baseCurrency &&
    baseAmountEdited &&
    values.base_amount_minor !== null
  ) {
    body.base_amount_minor = values.base_amount_minor;
  }

  return body;
}

/**
 * Edit-mode prefill for the converted field.
 *
 * AM-5: the stored minor value is decoded with its OWN paired `base_currency` —
 * never the profile base, never a `?? fallback`. A snapshot whose pair no longer
 * matches the profile's base currency (the D5 base-change bypass) is NOT shown:
 * presenting it would claim an override is active in a currency that is no longer
 * the base. It degrades to "" (auto), and any edit recomputes server-side.
 */
export function editPrefillBaseAmount(tx: SnapshotPair, baseCurrency: string): string {
  const minor = tx.base_amount_minor;
  const snapshotCurrency = tx.base_currency;
  if (minor === null || snapshotCurrency === null) return '';
  if (snapshotCurrency !== baseCurrency) return '';
  return toInputString(minor, snapshotCurrency);
}
