// May the transaction form ask the server what an account will be charged?
//
// Pure, and separate from the screen, because this is the guard on a MONEY
// invariant rather than a rendering detail: a number the user typed into the
// "charged" field is what goes on the wire as `amount_minor`, and NOTHING on the
// client may overwrite, re-derive or second-guess it (architecture D8 — only the
// server multiplies by a rate). The estimate this decision unlocks is TEXT next
// to the field; it never writes into it. But the cheapest way to make "it can
// never overwrite what I typed" true is to not even ask while there is something
// typed — so that is the rule, and it is pinned by a test.
//
// Every other arm is about not sending a request that cannot mean anything:
// single-currency operations (nothing to convert), edit mode (the STORED amount
// is the truth on screen), an unparseable amount, a half-typed date.
import { parseMoney } from '@budget/shared';

// The type comes from data/queryKeys (which imports nothing but api-client
// types), not from data/fx — data/fx reaches lib/api and therefore expo-secure-
// store, which must never enter the vitest graph.
import type { FxConvertParams } from '../../data/queryKeys';

// occurred_at as the form holds it; a half-typed date must not reach the endpoint.
const API_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface ChargePreviewInput {
  /** Create or edit. An edit shows the stored charge, never an estimate. */
  isEdit: boolean;
  /** Is the operation denominated in a currency other than the account's? */
  pairMode: boolean;
  /** The RAW "charged to the account" input. Non-empty = the user's own number. */
  chargedRaw: string;
  /** The RAW "spent" input, already debounced and normalized by the caller. */
  spentNormalized: string;
  /** The currency the money was spent in (the pair's). */
  spendCurrency: string;
  /** The account's currency — what the charge is denominated in. */
  accountCurrency: string;
  /** occurred_at, already debounced. */
  date: string;
}

/**
 * The `GET /fx/convert` parameters for the charge estimate, or `null` for "do not
 * ask". `null` is the default answer: an estimate is a nicety, and the form is
 * fully usable without one.
 */
export function chargePreviewRequest(input: ChargePreviewInput): FxConvertParams | null {
  if (input.isEdit || !input.pairMode) return null;
  // THE rule: a typed charge wins, absolutely. Not "the preview loses a race" —
  // there is no race, because no request is made at all.
  if (input.chargedRaw.trim() !== '') return null;
  if (!API_DATE_PATTERN.test(input.date)) return null;

  // Encoding the query parameter, not converting: the spent amount is read with
  // the currency IT is denominated in (AM-5).
  const spent = parseMoney(input.spentNormalized, input.spendCurrency);
  if (!spent.ok) return null;

  return {
    amountMinor: spent.minor,
    from: input.spendCurrency,
    to: input.accountCurrency,
    date: input.date,
  };
}
