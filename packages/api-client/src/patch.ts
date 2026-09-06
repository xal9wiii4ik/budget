// PATCH-body builders (obligations C1 / T7). Both emit ONLY the fields that
// changed relative to the edit form's initial values, and this is the SINGLE place
// where the RHF empty sentinel `""` is interpreted — for PATCH diffs (below) via
// `clearableChange`, and for CREATE bodies via the exported `emptyToNull` bridge
// (used at the create call sites so they don't open-code the ""→null rule):
//
//   nullable-clearable field (icon/color/category_id/note/goal_item_id):
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

/**
 * The plan item an expense is attached to (goal-planner W2).
 *
 * A SEPARATE optional member rather than a field of
 * `MultiCurrencyTransactionFormValues`, because it is not a member of the shared
 * zod form at all: only the web form renders the two-step picker, and it holds
 * the choice next to `receipt_id` — as component state, not a schema field.
 * Optional is load-bearing: apps/mobile calls the 3-arg overload (it is a
 * multi-currency form) with an object that has no such key, so its every edit
 * must keep reading as "this client has no opinion", never as a clear. That is
 * what the `?? ''` normalisation in the builder guarantees, and what
 * patch.test.ts pins.
 */
export type GoalItemLink = {
  /** `''` is the "not attached" sentinel — the category_id/note convention. */
  goal_item_id?: string;
};

// Implementation-signature shape: both public shapes are assignable to it.
// `amount` is widened to `number | null` because the multi-currency form may now
// leave the CHARGED amount blank while an original (spent) pair is present —
// "server, work out what the account was charged" (architecture §3).
type AnyTransactionFormValues = Omit<TransactionFormValues, 'amount'> & {
  amount: number | null;
  account_id?: string;
  currency?: string;
  base_amount_minor?: number | null;
  original_amount_minor?: number | null;
  original_currency?: string | null;
  country?: string;
} & GoalItemLink;

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
 *
 * goal-planner W2: `goal_item_id` takes the clearable trichotomy, normalised
 * from `undefined` on BOTH sides so a client that renders no picker emits no key
 * (see `GoalItemLink`).
 *
 * transaction-details-and-i18n S1/S2 (3-arg form only): the ORIGINAL pair —
 * `original_amount_minor` + `original_currency` — is emitted ATOMICALLY, and
 * `country` takes the clearable trichotomy. Both are absent from the 2-arg form:
 * the frozen mobile client renders neither control, so its every edit must read
 * as "no opinion", never as a clear.
 */
export function buildTransactionPatch(
  values: SingleCurrencyTransactionFormValues,
  initial: SingleCurrencyTransactionFormValues,
): TransactionUpdate;
export function buildTransactionPatch(
  values: MultiCurrencyTransactionFormValues & GoalItemLink,
  initial: MultiCurrencyTransactionFormValues & GoalItemLink,
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

  // amount is already the parsed minor number (moneyAmountSchema output).
  //
  // transaction-details-and-i18n S1: a BLANK charged amount (`null`) is not an
  // intent to clear — `amount_minor` is NOT NULL server-side. It means "recompute
  // it from the original pair" (PATCH row 4), which the server does precisely
  // when the pair is present and this key is ABSENT. So a null never reaches the
  // wire: the key is simply omitted, and the pair below carries the intent.
  if (values.amount !== null && values.amount !== initial.amount) {
    patch.amount_minor = values.amount;
  }
  if (values.kind !== initial.kind) patch.kind = values.kind;
  if (values.occurred_at !== initial.occurred_at) patch.occurred_at = values.occurred_at;

  const categoryId = clearableChange(values.category_id, initial.category_id);
  if (categoryId !== undefined) patch.category_id = categoryId;

  const note = clearableChange(values.note, initial.note);
  if (note !== undefined) patch.note = note;

  // goal-planner W2: the plan item this expense pays for — the category_id
  // trichotomy exactly (attached -> the id, detached -> explicit `null`,
  // untouched -> no key). The `?? ''` on BOTH sides is the whole safety
  // property: a caller that does not render the picker (apps/mobile, and every
  // 2-arg caller) has the key on neither side, both normalise to `''`, and the
  // diff is "unchanged" — so no `goal_item_id` is ever emitted from a client
  // that cannot have an opinion about it. An emitted `null` would silently
  // detach an operation somebody linked on the web.
  const goalItemId = clearableChange(values.goal_item_id ?? '', initial.goal_item_id ?? '');
  if (goalItemId !== undefined) patch.goal_item_id = goalItemId;

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

    // The ORIGINAL (spent) pair is ONE unit of meaning, so it is diffed as one
    // (architecture §3): unchanged -> neither key, cleared -> BOTH keys null,
    // changed -> BOTH keys with values. Half a pair is a 422
    // (`ORIGINAL_FIELDS_REQUIRED`) and, worse, an ambiguous intent — emitting
    // only the amount while the stored currency stays would silently redenominate
    // what the user spent.
    //
    // Note what is NOT here: clearing the pair does not touch `amount_minor`. The
    // charge is what actually left the account and stays the source of truth
    // (architecture §3, PATCH row 2); and a pair emitted WITHOUT an amount_minor
    // key is exactly how the user asks the server to recompute the charge.
    const nextCurrency = values.original_currency ?? null;
    const nextAmount = values.original_amount_minor ?? null;
    const prevCurrency = initial.original_currency ?? null;
    const prevAmount = initial.original_amount_minor ?? null;
    if (nextCurrency !== prevCurrency || nextAmount !== prevAmount) {
      const cleared = nextCurrency === null || nextAmount === null;
      patch.original_amount_minor = cleared ? null : nextAmount;
      patch.original_currency = cleared ? null : nextCurrency;
    }

    // The country of the operation: the note/category_id trichotomy.
    const country = clearableChange(values.country ?? '', initial.country ?? '');
    if (country !== undefined) patch.country = country;
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
 * `category_id`, `merchant`, `note`; `start_date` and `end_date` take the
 * nullable-VALUE form of the same rule because the schema already folded their
 * "" to `null`.
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
  // NO `account_id` key — and NOT because the contract lacks one: it has
  // `RecurringTemplateUpdate.account_id?: string | null`. Both clients keep a
  // template's account CREATE-only on purpose, and both edit forms render it
  // read-only, so there is nothing here to diff. Re-homing a template is not a
  // one-key change: its currency is stamped from its account server-side, so
  // moving it across accounts drags the amount, the currency and every charge
  // already materialized from it behind — a product decision that deserves a
  // scope of its own rather than a silently emitted key.
  if (values.amount_minor !== initial.amount_minor) patch.amount_minor = values.amount_minor;
  if (values.kind !== initial.kind) patch.kind = values.kind;
  if (values.currency !== initial.currency) patch.currency = values.currency;

  const categoryId = clearableChange(values.category_id, initial.category_id);
  if (categoryId !== undefined) patch.category_id = categoryId;

  const merchant = clearableChange(values.merchant, initial.merchant);
  if (merchant !== undefined) patch.merchant = merchant;

  const note = clearableChange(values.note, initial.note);
  if (note !== undefined) patch.note = note;

  // `start_date` takes the same nullable-VALUE form as `end_date` (the schema
  // already folded its "" to `null`) — and here the explicit null is LOAD-BEARING:
  // it rewinds a future seed back to the template's natural schedule (A4). A
  // dropped key would silently mean "keep the seed".
  const startDate = nullableChange(values.start_date, initial.start_date);
  if (startDate !== undefined) patch.start_date = startDate;

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
