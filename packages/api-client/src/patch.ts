// PATCH-body builders (obligations C1 / T7). Both emit ONLY the fields that
// changed relative to the edit form's initial values, and this is the SINGLE place
// where the RHF empty sentinel `""` is interpreted — for PATCH diffs (below) via
// `clearableChange`, and for CREATE bodies via the exported `emptyToNull` bridge
// (used at the create call sites so they don't open-code the ""→null rule):
//
//   nullable-clearable field (icon/color/category_id/note):
//     changed to ""            -> emit `null`   (explicit clear)
//     changed to a non-"" str  -> emit the string
//     unchanged                -> omit
//   non-nullable field (name/kind/amount_minor/occurred_at):
//     changed                  -> emit the value (never null/undefined)
//     unchanged                -> omit
//
// `undefined` is NEVER emitted as an intent — JSON.stringify would drop the key,
// which the server reads as "preserve", silently masking a would-be clear. The
// helper returns `undefined` only to signal "omit this key", and the caller skips
// assigning it, so it never reaches the wire.
import type { components } from './generated/schema';
import type { CategoryFormValues, TransactionFormValues } from '@budget/shared';

type CategoryUpdate = components['schemas']['CategoryUpdate'];
type TransactionUpdate = components['schemas']['TransactionUpdate'];

// CREATE-body bridge: the RHF empty sentinel `""` on an optional field becomes an
// explicit `null` on the wire; a non-empty value passes through. The create paths
// use this so the ""→null rule lives in one place (mirrors clearableChange's
// interpretation, minus the change-detection the PATCH diff needs).
export function emptyToNull(value: string): string | null {
  return value === '' ? null : value;
}

// A nullable-clearable string field: returns the value to assign, or `undefined`
// to omit the key entirely.
function clearableChange(next: string, prev: string): string | null | undefined {
  if (next === prev) return undefined;
  return next === '' ? null : next;
}

export function buildCategoryPatch(
  values: CategoryFormValues,
  initial: CategoryFormValues,
): CategoryUpdate {
  const patch: CategoryUpdate = {};

  if (values.name !== initial.name) patch.name = values.name;
  if (values.kind !== initial.kind) patch.kind = values.kind;

  const icon = clearableChange(values.icon, initial.icon);
  if (icon !== undefined) patch.icon = icon;

  // C7: compare color case-insensitively so a case-only difference (server may
  // store a canonical casing) is not resent as a spurious change. When it truly
  // changed, emit the user's value verbatim (server owns canonicalisation).
  if (values.color.toLowerCase() !== initial.color.toLowerCase()) {
    patch.color = values.color === '' ? null : values.color;
  }

  return patch;
}

export function buildTransactionPatch(
  values: TransactionFormValues,
  initial: TransactionFormValues,
): TransactionUpdate {
  const patch: TransactionUpdate = {};

  // amount is already the parsed minor number (moneyAmountSchema output); never null.
  if (values.amount !== initial.amount) patch.amount_minor = values.amount;
  if (values.kind !== initial.kind) patch.kind = values.kind;
  if (values.occurred_at !== initial.occurred_at) patch.occurred_at = values.occurred_at;

  const categoryId = clearableChange(values.category_id, initial.category_id);
  if (categoryId !== undefined) patch.category_id = categoryId;

  const note = clearableChange(values.note, initial.note);
  if (note !== undefined) patch.note = note;

  return patch;
}
