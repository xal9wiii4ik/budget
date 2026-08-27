// PATCH body for one deposit: a DIFF against output-shaped initial values —
// unchanged → OMIT, cleared → explicit `null`, changed → value (the house patch
// discipline). It lives beside the feature rather than in `@budget/api-client`
// for the `buildGoalItemPatch` reason: the builders there are SHARED with the
// frozen mobile client and are typed against `@budget/shared`'s form values,
// while this form's schema is web-local and has no mobile twin.
//
// Three server rules shape it (routers/deposits.py `update_deposit`):
//
//   * `name` / `rate_percent` / `capitalization` / `opened_on` are NOT NULL
//     columns — an explicit null is a `DEPOSIT_*_REQUIRED` 422 — so they are
//     emitted only when changed and never as null;
//   * `term_end` and `tax_rate_percent` are the nullable pair: cleared means
//     "open-ended" and "not taxed" respectively, and BOTH need an explicit null
//     to say so. A dropped key would silently keep the old term or keep taxing;
//   * `archived` is deliberately absent. Archiving (and un-archiving) is a
//     row-level action with its own confirmation and its own ONE-FIELD PATCH —
//     which is not merely a house convention here: the server accepts a write on
//     an archived deposit only as exactly `{archived: false}` and nothing else
//     (`DEPOSIT_UNARCHIVE_ONLY`). A builder that could emit the flag beside other
//     fields would make that code reachable.
//
// `currency` and `initial_balance_minor` have no PATCH representation at all: the
// currency belongs to the hidden ledger account and is immutable there, and the
// opening body is a create-time setup fact — offering it again on edit would be a
// second source of truth about the same money.
import type { DepositUpdate } from '../../data/deposits';
import type { DepositFormValues } from './depositFormSchema';

function nullableChange<T>(next: T | null, previous: T | null): T | null | undefined {
  if (next === previous) return undefined;
  return next;
}

export function buildDepositPatch(
  values: DepositFormValues,
  initial: DepositFormValues,
): DepositUpdate {
  const patch: DepositUpdate = {};

  if (values.name !== initial.name) patch.name = values.name;
  // Compared and sent as the STRING both sides speak. The server normalises its
  // stored Decimal on the way out ("10.00" comes back as "10"), and the edit
  // form is prefilled from that response — so an untouched field compares equal
  // and no spurious rate write is sent.
  if (values.rate_percent !== initial.rate_percent) patch.rate_percent = values.rate_percent;
  if (values.capitalization !== initial.capitalization) {
    patch.capitalization = values.capitalization;
  }
  if (values.opened_on !== initial.opened_on) patch.opened_on = values.opened_on;

  const termEnd = nullableChange(values.term_end, initial.term_end);
  if (termEnd !== undefined) patch.term_end = termEnd;

  const taxRate = nullableChange(values.tax_rate_percent, initial.tax_rate_percent);
  if (taxRate !== undefined) patch.tax_rate_percent = taxRate;

  return patch;
}
