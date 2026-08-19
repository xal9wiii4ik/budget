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
//   non-nullable field (name/kind/amount_minor/occurred_at/currency):
//     changed                  -> emit the value (never null/undefined)
//     unchanged                -> omit
//   nullable-VALUE field (base_amount_minor, 3.2): the form state is already
//   `number | null` (the schema folded the ""-as-auto sentinel), so the diff is
//     changed                  -> emit the number, or `null` to DISCARD a stored
//                                 override and let the server recompute (D5 row 5)
//     unchanged                -> omit
//   ...plus one field-independent rule: no base_amount_minor key at all while the
//   effective currency is the base currency (see buildTransactionPatch).
//
// `undefined` is NEVER emitted as an intent — JSON.stringify would drop the key,
// which the server reads as "preserve", silently masking a would-be clear. The
// helper returns `undefined` only to signal "omit this key", and the caller skips
// assigning it, so it never reaches the wire.
import type { components } from './generated/schema';
import type {
  AccountFormValues,
  CategoryFormValues,
  GoalFormValues,
  MultiCurrencyTransactionFormValues,
  RecurringTemplateFormValues,
  TransactionFormValues,
  TransferFormValues,
} from '@budget/shared';

type AccountUpdate = components['schemas']['AccountUpdate'];
type CategoryUpdate = components['schemas']['CategoryUpdate'];
type TransactionUpdate = components['schemas']['TransactionUpdate'];
type GoalUpdate = components['schemas']['GoalUpdate'];
type RecurringTemplateUpdate = components['schemas']['RecurringTemplateUpdate'];

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

/**
 * AccountUpdate patch builder (accounts-and-transfers W1).
 *
 * Three fields, all NOT NULL server-side, so the never-null rule applies to each:
 * changed -> emit, unchanged -> omit, never `null` (an explicit null is a
 * `*_REQUIRED` 422).
 *
 * Two columns are deliberately ABSENT:
 *   `currency` — immutable after creation (architecture §4: every row on an
 *                account is denominated in it, and there is no cascading
 *                restamp). Sending it at all is 422 ACCOUNT_CURRENCY_IMMUTABLE,
 *                so the form renders it read-only and the builder cannot emit it.
 *   `archived` — archiving is a row-level action behind its own confirmation with
 *                its own one-field PATCH (the goals/categories precedent), not
 *                something a Save button changes silently.
 */
export function buildAccountPatch(
  values: AccountFormValues,
  initial: AccountFormValues,
): AccountUpdate {
  const patch: AccountUpdate = {};

  if (values.name !== initial.name) patch.name = values.name;
  if (values.type !== initial.type) patch.type = values.type;
  if (values.starting_balance_minor !== initial.starting_balance_minor) {
    patch.starting_balance_minor = values.starting_balance_minor;
  }

  return patch;
}

// The nullable-VALUE analogue of clearableChange: for a field whose form state is
// already `T | null` (base_amount_minor, where the ""-as-auto sentinel was folded
// to null by the schema). `undefined` means "omit the key"; an emitted `null` is an
// explicit intent — for base_amount_minor it is D5/PATCH-row-5's
// discard-the-override-and-recompute, NOT "the value is unknown".
function nullableChange<T>(next: T | null, prev: T | null): T | null | undefined {
  return next === prev ? undefined : next;
}

// The single-currency (pre-3.2) shape: mobile still calls the 2-arg overload with
// it. The `?: never` members make a multi-currency value object structurally
// INCOMPATIBLE with this overload, so a 3.2 caller cannot accidentally land here
// and have its currency / base_amount_minor intents silently dropped.
type SingleCurrencyTransactionFormValues = TransactionFormValues & {
  account_id?: never;
  currency?: never;
  base_amount_minor?: never;
};

// Implementation-signature shape: both public shapes are assignable to it.
type AnyTransactionFormValues = TransactionFormValues & {
  account_id?: string;
  currency?: string;
  base_amount_minor?: number | null;
};

/**
 * TransactionUpdate patch builder (T7, extended in 3.2 for multi-currency).
 *
 * 2-arg form: the frozen single-currency form (apps/mobile) — unchanged behavior,
 * no `currency` / `base_amount_minor` key is ever emitted.
 *
 * 3-arg form: the multi-currency form. `baseCurrency` is the PROFILE base (what
 * the server will convert into), which is what makes PATCH row 3 decidable here:
 * whenever the transaction's EFFECTIVE currency is the base currency, no
 * `base_amount_minor` key is emitted at all — even when the same patch changes the
 * currency to base while a stale value sits in the (hidden) converted field. That
 * body would 422 as BASE_AMOUNT_WITHOUT_CURRENCY.
 */
export function buildTransactionPatch(
  values: SingleCurrencyTransactionFormValues,
  initial: SingleCurrencyTransactionFormValues,
): TransactionUpdate;
export function buildTransactionPatch(
  values: MultiCurrencyTransactionFormValues,
  initial: MultiCurrencyTransactionFormValues,
  baseCurrency: string,
): TransactionUpdate;
export function buildTransactionPatch(
  values: AnyTransactionFormValues,
  initial: AnyTransactionFormValues,
  baseCurrency?: string,
): TransactionUpdate {
  const patch: TransactionUpdate = {};

  // accounts-and-transfers W1: moving a row to another account is a normal
  // never-null field diff here — but a THREE-fold effect server-side (it
  // restamps `currency` from the new account and recomputes the base snapshot,
  // architecture §4). The paired `currency` key below is emitted by the same
  // diff and always agrees with it, because the form's currency is a derived
  // echo of the selected account's.
  if (values.account_id !== undefined && values.account_id !== initial.account_id) {
    patch.account_id = values.account_id;
  }

  // amount is already the parsed minor number (moneyAmountSchema output); never null.
  if (values.amount !== initial.amount) patch.amount_minor = values.amount;
  if (values.kind !== initial.kind) patch.kind = values.kind;
  if (values.occurred_at !== initial.occurred_at) patch.occurred_at = values.occurred_at;

  const categoryId = clearableChange(values.category_id, initial.category_id);
  if (categoryId !== undefined) patch.category_id = categoryId;

  const note = clearableChange(values.note, initial.note);
  if (note !== undefined) patch.note = note;

  // Multi-currency arm (3-arg form only). `currency` is non-nullable: changed ->
  // emit, unchanged -> omit, never null (the server 422s CURRENCY_REQUIRED).
  const currency = values.currency;
  if (baseCurrency !== undefined && currency !== undefined) {
    if (currency !== initial.currency) patch.currency = currency;

    // Row-3 guard: a base-currency row has no snapshot to own, so the key is
    // dropped regardless of field state. Otherwise the trichotomy applies:
    // unchanged -> omit, value -> number, cleared-to-auto -> explicit null.
    if (currency !== baseCurrency) {
      const baseAmount = nullableChange(
        values.base_amount_minor ?? null,
        initial.base_amount_minor ?? null,
      );
      if (baseAmount !== undefined) patch.base_amount_minor = baseAmount;
    }
  }

  return patch;
}

/**
 * TransactionUpdate patch builder for a TRANSFER row (accounts-and-transfers W1).
 *
 * A separate builder rather than a branch in `buildTransactionPatch`: a transfer
 * has no category, no kind choice and no base snapshot (architecture §5 — the
 * base pair is NULL by CHECK), and it has two fields nothing else has. Sharing
 * one builder would mean a body where half the keys are permanently unreachable.
 *
 * Never-null (changed -> emit, unchanged -> omit): both account ids and both
 * amounts, plus `occurred_at`. `note` takes the clearable trichotomy.
 *
 * Deliberately absent:
 *   `currency` / `counter_currency` — STAMPS of the two accounts (§4/A5); the
 *       server writes them from the effective accounts, and a client copy could
 *       only ever disagree (422 ACCOUNT_CURRENCY_MISMATCH).
 *   `kind` — changing kind to/from transfer is 422 KIND_CHANGE_UNSUPPORTED; the
 *       way to convert an operation is delete + create, so the form never offers
 *       it and the builder cannot emit it.
 *   `transfer_rate` — a DERIVED server field (A2), not a column.
 */
export function buildTransferPatch(
  values: TransferFormValues,
  initial: TransferFormValues,
): TransactionUpdate {
  const patch: TransactionUpdate = {};

  if (values.account_id !== initial.account_id) patch.account_id = values.account_id;
  if (values.amount_minor !== initial.amount_minor) patch.amount_minor = values.amount_minor;
  if (values.counter_account_id !== initial.counter_account_id) {
    patch.counter_account_id = values.counter_account_id;
  }
  if (values.counter_amount_minor !== initial.counter_amount_minor) {
    patch.counter_amount_minor = values.counter_amount_minor;
  }
  if (values.occurred_at !== initial.occurred_at) patch.occurred_at = values.occurred_at;

  const note = clearableChange(values.note, initial.note);
  if (note !== undefined) patch.note = note;

  return patch;
}

/**
 * GoalUpdate patch builder (T7 discipline, 3.2 W3).
 *
 * `deadline` is the ONE user-owned nullable column here (D12), so it takes the
 * nullable trichotomy: unchanged -> omit, set -> the "YYYY-MM-DD" string, cleared
 * -> explicit `null` (the server clears the column). name / target_minor /
 * currency are NOT NULL server-side (`*_REQUIRED` 422 on an explicit null), so
 * they are emitted only when changed and never as null.
 *
 * `priority` is a special case of the same rule: the form's blank field means
 * "append last" on CREATE, but a PATCH has nothing to append — the goal already
 * has a stored priority and `priority: null` would 422 PRIORITY_REQUIRED. A
 * blanked priority field is therefore treated as "leave it alone" (key omitted).
 *
 * `archived` is deliberately NOT part of this builder: archiving is a card-level
 * action with its own confirmation and its own one-field PATCH (the C6 pattern),
 * not something the edit form can change behind a Save button.
 *
 * `initial_saved_minor` is create-only (it becomes the goal's first contribution
 * row); it has no PATCH representation at all.
 */
export function buildGoalPatch(values: GoalFormValues, initial: GoalFormValues): GoalUpdate {
  const patch: GoalUpdate = {};

  if (values.name !== initial.name) patch.name = values.name;
  if (values.target_minor !== initial.target_minor) patch.target_minor = values.target_minor;
  if (values.currency !== initial.currency) patch.currency = values.currency;

  const deadline = nullableChange(values.deadline, initial.deadline);
  if (deadline !== undefined) patch.deadline = deadline;

  if (values.priority !== null && values.priority !== initial.priority) {
    patch.priority = values.priority;
  }

  return patch;
}

/**
 * RecurringTemplateUpdate patch builder (T7, third builder — 5.3 WR-9).
 *
 * Never-null (changed -> emit, unchanged -> omit, never `null`): `name`,
 * `amount_minor`, `kind`, `currency`, `interval_unit` — all NOT NULL server-side,
 * where an explicit null is a `*_REQUIRED` 422.
 *
 * Clearable trichotomy (unchanged -> omit, "" -> explicit `null`, value -> value):
 * `category_id`, `merchant`, `note`; `end_date` takes the nullable-VALUE form of
 * the same rule because the schema already folded its "" to `null`.
 *
 * The ANCHOR PAIR is NOT a naive field diff. The server judges the pair this
 * PATCH will LEAVE BEHIND (`eff_unit` in routers/recurring.py), so:
 *
 *   - only the anchor matching the EFFECTIVE (post-patch) unit is ever emitted;
 *   - it is emitted when it changed OR when the unit changed (the new unit's
 *     anchor is required — ANCHOR_REQUIRED otherwise);
 *   - the NON-matching anchor key is never emitted at all — not as a value (that
 *     is ANCHOR_MISMATCH) and not as an explicit `null` (pointless: the server
 *     clears a merely-stored stale anchor itself).
 *
 * A naive diff fails exactly the month->week arm: it would resend the stale
 * `day_of_month` alongside the new `weekday` and collect an ANCHOR_MISMATCH.
 *
 * `paused` is deliberately NOT in this builder: pause/resume is a row-level
 * action with its own one-field PATCH behind its own affordance (the goals
 * `archived` precedent). Sending `paused` on every save would also make every
 * edit a pause TRANSITION candidate on the server (SL-A).
 */
export function buildRecurringTemplatePatch(
  values: RecurringTemplateFormValues,
  initial: RecurringTemplateFormValues,
): RecurringTemplateUpdate {
  const patch: RecurringTemplateUpdate = {};

  if (values.name !== initial.name) patch.name = values.name;
  // NO `account_id` key: `RecurringTemplateUpdate` does not carry one on the
  // current contract (B1 added the column and the CREATE field; the PATCH field
  // belongs to B2). Emitting it would be a hand-written key the generated type
  // does not have — so a template's account is create-time only for now, and the
  // form renders it read-only on edit rather than pretending it is editable.
  if (values.amount_minor !== initial.amount_minor) patch.amount_minor = values.amount_minor;
  if (values.kind !== initial.kind) patch.kind = values.kind;
  if (values.currency !== initial.currency) patch.currency = values.currency;

  const categoryId = clearableChange(values.category_id, initial.category_id);
  if (categoryId !== undefined) patch.category_id = categoryId;

  const merchant = clearableChange(values.merchant, initial.merchant);
  if (merchant !== undefined) patch.merchant = merchant;

  const note = clearableChange(values.note, initial.note);
  if (note !== undefined) patch.note = note;

  const endDate = nullableChange(values.end_date, initial.end_date);
  if (endDate !== undefined) patch.end_date = endDate;

  const unitChanged = values.interval_unit !== initial.interval_unit;
  if (unitChanged) patch.interval_unit = values.interval_unit;

  // `values` always comes from `recurringTemplateFormSchema`, which mirrors the DB
  // CHECK — the effective unit's anchor is non-null there by construction, so this
  // reads the one member that exists and never invents a null.
  if (values.interval_unit === 'month') {
    if (unitChanged || values.day_of_month !== initial.day_of_month) {
      patch.day_of_month = values.day_of_month;
    }
  } else if (unitChanged || values.weekday !== initial.weekday) {
    patch.weekday = values.weekday;
  }

  return patch;
}
