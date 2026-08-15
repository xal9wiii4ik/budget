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
 * POST /transactions body. `currency` is always explicit; `base_amount_minor` is
 * included only for a foreign row whose converted field a human edited to a
 * parseable value.
 */
export function buildCreateBody(
  values: MultiCurrencyTransactionFormValues,
  baseCurrency: string,
  baseAmountEdited: boolean,
): TransactionCreate {
  const body: TransactionCreate = {
    amount_minor: values.amount,
    currency: values.currency,
    kind: values.kind,
    category_id: emptyToNull(values.category_id),
    occurred_at: values.occurred_at,
    note: emptyToNull(values.note),
  };

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
