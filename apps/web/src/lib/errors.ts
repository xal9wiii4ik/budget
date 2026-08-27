// App-side error layer for category / transaction mutations (obligations C2 / T6 /
// A3). Reuses the shared, platform-free getErrorCode + the runtime ValidationError[]
// narrow from @budget/api-client (the narrow now lives in the package, not here,
// because the generated POST/PATCH 422 type declares {detail:string} and does NOT
// model the Pydantic array FastAPI really returns) and adds stable-code -> field
// routing tables per resource.
import { getErrorCode, getValidationIssues, routeIssue, type FieldError } from '@budget/api-client';
import { errorMessage, type Lang } from '@budget/shared';

import { ApiError } from './query';

// Exported (W1/P1) so the one sentence the app uses for "the request never
// reached the server" has a single home: mutation forms route it through the
// describe*Error helpers below, reads render it via <QueryStateNotice> and the
// shell's me-query affordance. Since i18n (S5) it takes the language: the copy
// itself lives in @budget/shared (mobile shows the same sentences), while the
// code -> field routing below stays a web concern.
export function networkMessage(lang: Lang): string {
  return errorMessage('network', lang);
}

type CategoryField = 'name' | 'icon' | 'color' | 'kind';
const CATEGORY_FIELDS: readonly CategoryField[] = ['name', 'icon', 'color', 'kind'];

export function describeCategoryError(error: unknown, lang: Lang): FieldError<CategoryField> {
  if (!(error instanceof ApiError)) {
    return { field: 'form', message: errorMessage('network', lang) };
  }

  switch (getErrorCode(error.body)) {
    case 'SYSTEM_CATEGORY_READONLY':
      return { field: 'form', message: errorMessage('category.systemReadonly', lang) };
    case 'CATEGORY_NOT_FOUND':
      return {
        field: 'form',
        message: errorMessage('category.notFound', lang),
      };
    // Fires on rename OR a kind-only PATCH (C2): always a name collision within a
    // kind, so it is always routed to the name field, never a generic failure.
    case 'CATEGORY_NAME_CONFLICT':
      return {
        field: 'name',
        message: errorMessage('category.nameConflict', lang),
      };
  }

  const issues = getValidationIssues(error.body);
  if (issues) {
    const routed = routeIssue(issues, CATEGORY_FIELDS);
    if (routed) return routed;
  }

  return { field: 'form', message: errorMessage('generic', lang) };
}

// --- Accounts (accounts-and-transfers W1) ---------------------------------
// The account form's own failures. `currency` is in the field list although the
// form renders it read-only on edit: a 422 about it is then a bug signal, and
// landing it next to the control the user CAN see beats a silent catch-all.

type AccountField = 'name' | 'type' | 'currency' | 'starting_balance_minor';
const ACCOUNT_FIELDS: readonly AccountField[] = [
  'name',
  'type',
  'currency',
  'starting_balance_minor',
];

export function describeAccountError(error: unknown, lang: Lang): FieldError<AccountField> {
  if (!(error instanceof ApiError)) {
    return { field: 'form', message: errorMessage('network', lang) };
  }

  switch (getErrorCode(error.body)) {
    // The no-oracle 404: missing and foreign resolve to the same code, and by the
    // time a form sees it the honest reading is always "it is not there any more".
    case 'ACCOUNT_NOT_FOUND':
      return {
        field: 'form',
        message: errorMessage('account.notFound', lang),
      };
    // Fires on a write against an archived account (the selector excludes them, so
    // this takes a stale screen) — the copy says what actually unblocks the user.
    case 'ACCOUNT_ARCHIVED':
      return {
        field: 'form',
        message: errorMessage('account.archived', lang),
      };
    // The form makes the currency read-only on edit and the patch builder emits no
    // `currency` key at all, so this is unreachable from a correct client — but it
    // is the ONE rule a user could otherwise spend minutes fighting, so it names
    // the way out instead of "something went wrong".
    case 'ACCOUNT_CURRENCY_IMMUTABLE':
      return {
        field: 'currency',
        message: errorMessage('account.currencyImmutable', lang),
      };
  }

  const issues = getValidationIssues(error.body);
  if (issues) {
    const routed = routeIssue(issues, ACCOUNT_FIELDS);
    if (routed) return routed;
  }

  return { field: 'form', message: errorMessage('generic', lang) };
}

// --- Deposits (deposits W1) -----------------------------------------------
// The deposit form's own failures. `archived` is in the field list although no
// control carries it (archiving is its own one-field PATCH behind a confirm):
// the dialog reads the same message off `field: 'form'`, and listing the column
// keeps a Pydantic issue about it from falling through to the catch-all.

type DepositField =
  | 'name'
  | 'currency'
  | 'rate_percent'
  | 'capitalization'
  | 'opened_on'
  | 'term_end'
  | 'tax_rate_percent'
  | 'accrued_override_minor'
  | 'initial_balance_minor'
  | 'archived';
const DEPOSIT_FIELDS: readonly DepositField[] = [
  'name',
  'currency',
  'rate_percent',
  'capitalization',
  'opened_on',
  'term_end',
  'tax_rate_percent',
  'accrued_override_minor',
  'initial_balance_minor',
  'archived',
];

export function describeDepositError(error: unknown, lang: Lang): FieldError<DepositField> {
  if (!(error instanceof ApiError)) {
    return { field: 'form', message: errorMessage('network', lang) };
  }

  switch (getErrorCode(error.body)) {
    // The no-oracle 404: missing and foreign share one code, and by the time a
    // form sees it the honest reading is "it is not there any more".
    case 'DEPOSIT_NOT_FOUND':
      return { field: 'form', message: errorMessage('deposit.notFound', lang) };
    // A write against a closed deposit. The edit form disables its inputs for an
    // archived row, so this takes a stale tab — the copy names the way out.
    case 'DEPOSIT_ARCHIVED':
      return { field: 'form', message: errorMessage('deposit.archived', lang) };
    // Reopening carries the flag ALONE (the archive dialog sends exactly
    // `{archived:false}`), so this is unreachable from a correct client — but it
    // is the one rule a user could otherwise fight blind, so it says out loud
    // that reopening and editing are two steps instead of showing a raw code.
    case 'DEPOSIT_UNARCHIVE_ONLY':
      return { field: 'form', message: errorMessage('deposit.unarchiveOnly', lang) };
    // The schema compares the two dates before submit, so this takes a stale
    // screen too — routed to the control that can fix it.
    case 'DEPOSIT_TERM_BEFORE_OPENING':
      return { field: 'term_end', message: errorMessage('deposit.termBeforeOpening', lang) };
    // The *_REQUIRED family fires only on a body the patch builder never sends
    // (it emits no explicit null for any NOT NULL column) — a bug signal rather
    // than a user field error, the T6 precedent.
    case 'DEPOSIT_NAME_REQUIRED':
    case 'DEPOSIT_RATE_REQUIRED':
    case 'DEPOSIT_CAPITALIZATION_REQUIRED':
    case 'DEPOSIT_OPENED_ON_REQUIRED':
    case 'DEPOSIT_ARCHIVED_REQUIRED':
      return { field: 'form', message: errorMessage('generic', lang) };
  }

  const issues = getValidationIssues(error.body);
  if (issues) {
    const routed = routeIssue(issues, DEPOSIT_FIELDS);
    if (routed) return routed;
  }

  return { field: 'form', message: errorMessage('generic', lang) };
}

// `merchant` (S6) is create-only and exists on the confirm form alone; it is
// listed so a 422 on it lands on that input instead of the form-level catch-all.
//
// accounts-and-transfers W1: the transaction form now carries an account, and the
// TRANSFER form (features/transfers) routes through this same helper — its two
// account fields and its second amount are listed so a 422 lands on the control
// that can fix it rather than on the form root.
//
// goal-planner W2: `goal_item_id` joins the table — the plan-item picker is part
// of this form now, and the three codes an attachment can raise belong on it
// rather than on the form root (W1 left this note in the goal-item table below).
type TransactionField =
  | 'account_id'
  | 'amount_minor'
  | 'category_id'
  | 'counter_account_id'
  | 'counter_amount_minor'
  | 'occurred_at'
  | 'note'
  | 'merchant'
  | 'goal_item_id';
const TRANSACTION_FIELDS: readonly TransactionField[] = [
  'account_id',
  'amount_minor',
  'category_id',
  'counter_account_id',
  'counter_amount_minor',
  'occurred_at',
  'note',
  'merchant',
  'goal_item_id',
];

export function describeTransactionError(error: unknown, lang: Lang): FieldError<TransactionField> {
  if (!(error instanceof ApiError)) {
    return { field: 'form', message: errorMessage('network', lang) };
  }

  switch (getErrorCode(error.body)) {
    case 'TRANSACTION_NOT_FOUND':
      return {
        field: 'form',
        message: errorMessage('transaction.notFound', lang),
      };
    case 'CATEGORY_NOT_FOUND':
    case 'CATEGORY_ARCHIVED':
      return {
        field: 'category_id',
        message: errorMessage('categoryUnavailable', lang),
      };
    // goal-planner W2. The picker lists live goals and their real nodes, so both
    // of these take a stale tab (the item deleted, or its goal archived, next
    // door) — routed to the picker, which is the control that can fix them.
    case 'GOAL_ITEM_NOT_FOUND':
      return { field: 'goal_item_id', message: errorMessage('goalItem.notFound', lang) };
    case 'GOAL_ARCHIVED':
      return { field: 'goal_item_id', message: errorMessage('goal.archived', lang) };
    // A BUG SIGNAL, not a user error (the T6 family): the field is rendered on
    // expenses only, is cleared when the kind flips, and the value sent is
    // derived from the kind at submit time — so the wire cannot carry this pair
    // unless the client is broken. It still says something happened, because the
    // row would otherwise look saved.
    case 'GOAL_ITEM_EXPENSE_ONLY':
      return { field: 'form', message: errorMessage('generic', lang) };
    // accounts-and-transfers W1. Both codes are emitted for the SOURCE account and
    // for a transfer's counter account alike, and the wire does not say which —
    // so they are form-level: the message names both possibilities honestly rather
    // than blaming the wrong select. (The account cache is refreshed by the
    // mutation's own invalidation, so re-opening the form shows the real list.)
    case 'ACCOUNT_NOT_FOUND':
      return {
        field: 'form',
        message: errorMessage('transaction.accountUnavailable', lang),
      };
    case 'ACCOUNT_ARCHIVED':
      return {
        field: 'form',
        message: errorMessage('transaction.accountArchived', lang),
      };
    // §4: the server stamps `currency` from the account, and neither the create
    // body nor the patch builder sends a currency at all — so this is a bug
    // signal. It still says what happened, because the number on screen would
    // otherwise look saved.
    case 'ACCOUNT_CURRENCY_MISMATCH':
      return {
        field: 'form',
        message: errorMessage('transaction.currencyMismatch', lang),
      };
    // The transfer form's schema rejects an identical pair before submit, so this
    // takes a stale screen — it is routed to the target select, the control the
    // user can actually change.
    case 'SAME_ACCOUNT_TRANSFER':
      return {
        field: 'counter_account_id',
        message: errorMessage('transaction.sameAccountTransfer', lang),
      };
    // deposits W1: only a transfer may touch a deposit's ledger account. The
    // deposit side is never offered in the transaction form's picker (the
    // server hides deposit accounts from GET /accounts), so this takes a stale
    // screen — form-level, because the wire does not say which leg it is about.
    case 'DEPOSIT_ACCOUNT_TRANSFER_ONLY':
      return {
        field: 'form',
        message: errorMessage('transaction.depositTransferOnly', lang),
      };
    // Converting an operation to or from a transfer is not a PATCH (delete and
    // re-create instead). No UI offers it, so this is a bug signal.
    case 'KIND_CHANGE_UNSUPPORTED':
      return { field: 'form', message: errorMessage('generic', lang) };
    // S6: create with a `receipt_id` the server can no longer resolve. Nothing in
    // this scope can delete a receipt (no DELETE endpoint, D12), so it takes a
    // vanished row to fire — but it is mapped honestly instead of falling through
    // to "something went wrong". There is no way to unattach the photo from this
    // form, so the message says what actually gets the transaction saved.
    case 'RECEIPT_NOT_FOUND':
      return {
        field: 'form',
        message: errorMessage('transaction.receiptUnavailable', lang),
      };
    // These only fire from a malformed body the builder never sends — treat as an
    // unexpected-error signal, not a user field error (T6). 3.2 adds the two
    // multi-currency members of the same family: the shared schema nulls
    // base_amount_minor for a base-currency row and the patch builder drops the
    // key whenever the effective currency is the base, so reaching the server
    // with either code is a bug signal, not something the user can fix in a field.
    // The two COUNTER_* members join the family on the same argument: the counter
    // pair is written by one form that always sends both, so an inconsistent body
    // is a client bug, not user input.
    case 'AMOUNT_REQUIRED':
    case 'KIND_REQUIRED':
    case 'OCCURRED_AT_REQUIRED':
    case 'BASE_AMOUNT_WITHOUT_CURRENCY':
    case 'CURRENCY_REQUIRED':
    case 'COUNTER_FIELDS_WITHOUT_TRANSFER':
    case 'TRANSFER_FIELDS_REQUIRED':
      return { field: 'form', message: errorMessage('generic', lang) };
  }

  const issues = getValidationIssues(error.body);
  if (issues) {
    const routed = routeIssue(issues, TRANSACTION_FIELDS);
    if (routed) return routed;
  }

  return { field: 'form', message: errorMessage('generic', lang) };
}

// --- Goals (3.2 W3/W4, WD-5) ----------------------------------------------
// Two helpers, not one: a goal form and a contribution dialog have disjoint field
// sets and disjoint failure modes, and a shared catch-all would happily route a
// contribution's CONTRIBUTION_EXCEEDS_SAVED onto a goal field that cannot fix it.

type GoalField =
  | 'name'
  | 'target_minor'
  | 'currency'
  | 'deadline'
  | 'priority'
  // goal-planner W1: both are edited on the PLAN screen, not in the goal form,
  // and both are money — a 422 about either must land on the input that holds it
  // rather than on a form root the user cannot connect it to.
  | 'initial_budget_minor'
  | 'final_cost_override_minor';
const GOAL_FIELDS: readonly GoalField[] = [
  'name',
  'target_minor',
  'currency',
  'deadline',
  'priority',
  'initial_budget_minor',
  'final_cost_override_minor',
];

export function describeGoalError(error: unknown, lang: Lang): FieldError<GoalField> {
  if (!(error instanceof ApiError)) {
    return { field: 'form', message: errorMessage('network', lang) };
  }

  switch (getErrorCode(error.body)) {
    case 'GOAL_NOT_FOUND':
      return {
        field: 'form',
        message: errorMessage('goal.notFound', lang),
      };
    // The *_REQUIRED family fires only on a body the patch builder never sends
    // (it emits no explicit nulls for these columns) — a bug signal rather than a
    // user field error, the T6 precedent.
    case 'NAME_REQUIRED':
    case 'TARGET_REQUIRED':
    case 'CURRENCY_REQUIRED':
    case 'PRIORITY_REQUIRED':
    case 'ARCHIVED_REQUIRED':
      return { field: 'form', message: errorMessage('generic', lang) };
  }

  const issues = getValidationIssues(error.body);
  if (issues) {
    const routed = routeIssue(issues, GOAL_FIELDS);
    if (routed) return routed;
  }

  return { field: 'form', message: errorMessage('generic', lang) };
}

type ContributionField = 'amount_minor' | 'occurred_at' | 'note';
const CONTRIBUTION_FIELDS: readonly ContributionField[] = [
  'amount_minor',
  'occurred_at',
  'note',
];

export function describeContributionError(error: unknown, lang: Lang): FieldError<ContributionField> {
  if (!(error instanceof ApiError)) {
    return { field: 'form', message: errorMessage('network', lang) };
  }

  switch (getErrorCode(error.body)) {
    // The SUM >= 0 invariant is server-owned (C8: no client re-implementation as
    // a hard gate). It fires on a withdrawal AND on deleting a positive
    // contribution — in the delete dialog the same text renders as the operation
    // error, which is why the message names the goal balance, not the field.
    case 'CONTRIBUTION_EXCEEDS_SAVED':
      return {
        field: 'amount_minor',
        message: errorMessage('contribution.exceedsSaved', lang),
      };
    case 'CONTRIBUTION_NOT_FOUND':
      return {
        field: 'form',
        message: errorMessage('contribution.notFound', lang),
      };
    // A contribution write also 404s when the GOAL is gone.
    case 'GOAL_NOT_FOUND':
      return {
        field: 'form',
        message: errorMessage('goal.notFound', lang),
      };
  }

  const issues = getValidationIssues(error.body);
  if (issues) {
    const routed = routeIssue(issues, CONTRIBUTION_FIELDS);
    if (routed) return routed;
  }

  return { field: 'form', message: errorMessage('generic', lang) };
}

// --- Goal plan items (goal-planner W1) ------------------------------------
// Its own table for the reason above: a plan item's field set (a parent, a second
// amount in the goal's currency, a reminder intent) is disjoint from the goal
// form's, and the three STRUCTURE failures (parent gone / cycle / too deep) all
// belong on the parent picker — the one control that can fix them.
//
// Not in this table: the file codes (no files endpoints on the contract yet — the
// attachments subtask) and `GOAL_ITEM_EXPENSE_ONLY`, which is raised by the
// TRANSACTION write that attaches an operation — it lives in
// `describeTransactionError` since W2, together with the picker's own field.

type GoalItemField =
  | 'name'
  | 'description'
  | 'links'
  | 'amount_minor'
  | 'currency'
  | 'converted_minor'
  | 'deadline'
  | 'remind_on'
  | 'remind_days_before'
  | 'parent_id';
const GOAL_ITEM_FIELDS: readonly GoalItemField[] = [
  'name',
  'description',
  'links',
  'amount_minor',
  'currency',
  'converted_minor',
  'deadline',
  'remind_on',
  'remind_days_before',
  'parent_id',
];

export function describeGoalItemError(error: unknown, lang: Lang): FieldError<GoalItemField> {
  if (!(error instanceof ApiError)) {
    return { field: 'form', message: errorMessage('network', lang) };
  }

  switch (getErrorCode(error.body)) {
    case 'GOAL_ITEM_NOT_FOUND':
      return { field: 'form', message: errorMessage('goalItem.notFound', lang) };
    // The plan screen reads ONE goal; when it is gone every affordance on the
    // screen is stale, and the mutation's own 404 handler refetches the family.
    case 'GOAL_NOT_FOUND':
      return { field: 'form', message: errorMessage('goal.notFound', lang) };
    // The screen hides every write affordance on an archived goal, so this takes
    // a stale tab — the copy still names the way out (unarchive) instead of
    // "something went wrong".
    case 'GOAL_ARCHIVED':
      return { field: 'form', message: errorMessage('goal.archived', lang) };
    // The three structure refusals. `moveTargets` already excludes self,
    // descendants and targets that are too deep, so these fire from a stale tree
    // — routed to the parent picker, which is what the user re-chooses.
    case 'GOAL_ITEM_PARENT_NOT_FOUND':
      return { field: 'parent_id', message: errorMessage('goalItem.parentNotFound', lang) };
    case 'GOAL_ITEM_CYCLE':
      return { field: 'parent_id', message: errorMessage('goalItem.cycle', lang) };
    case 'GOAL_ITEM_DEPTH_EXCEEDED':
      return { field: 'parent_id', message: errorMessage('goalItem.depthExceeded', lang) };
    case 'GOAL_ITEMS_LIMIT_EXCEEDED':
      return { field: 'form', message: errorMessage('goalItem.limitExceeded', lang) };
    // The bug-signal family (T6). The form's schema mirrors every one of these
    // rules — exactly one reminder intent, a second amount only for a foreign
    // currency with an amount, and no explicit null for a NOT NULL column — so
    // reaching them means the CLIENT is broken, not the user.
    case 'GOAL_ITEM_REMIND_CONFLICT':
    case 'GOAL_ITEM_CONVERTED_NOT_APPLICABLE':
    case 'AMOUNT_REQUIRED':
    case 'NAME_REQUIRED':
    case 'CURRENCY_REQUIRED':
      return { field: 'form', message: errorMessage('generic', lang) };
  }

  const issues = getValidationIssues(error.body);
  if (issues) {
    const routed = routeIssue(issues, GOAL_ITEM_FIELDS);
    if (routed) return routed;
  }

  return { field: 'form', message: errorMessage('generic', lang) };
}

// --- Recurring templates (5.3 W2, WR-7) -----------------------------------
// Its own table: the template form's field set (a periodicity anchor, an end
// date, a merchant) is disjoint from every other resource's, and a shared
// catch-all would route an anchor failure onto a field that cannot fix it.

type RecurringField =
  | 'name'
  | 'account_id'
  | 'amount_minor'
  | 'category_id'
  | 'start_date'
  | 'end_date'
  | 'day_of_month'
  | 'weekday'
  | 'merchant'
  | 'note';
const RECURRING_FIELDS: readonly RecurringField[] = [
  'name',
  'account_id',
  'amount_minor',
  'category_id',
  'start_date',
  'end_date',
  'day_of_month',
  'weekday',
  'merchant',
  'note',
];

export function describeRecurringError(error: unknown, lang: Lang): FieldError<RecurringField> {
  if (!(error instanceof ApiError)) {
    return { field: 'form', message: errorMessage('network', lang) };
  }

  switch (getErrorCode(error.body)) {
    case 'RECURRING_TEMPLATE_NOT_FOUND':
      return {
        field: 'form',
        message: errorMessage('recurring.notFound', lang),
      };
    // The category is a BODY field here (the addressed resource is the template),
    // so both codes route to the picker — the transactions rule.
    case 'CATEGORY_NOT_FOUND':
    case 'CATEGORY_ARCHIVED':
      return {
        field: 'category_id',
        message: errorMessage('categoryUnavailable', lang),
      };
    // accounts-and-transfers: the template carries an account too, and the same
    // two codes reach this form from the account selector.
    case 'ACCOUNT_NOT_FOUND':
    case 'ACCOUNT_ARCHIVED':
      return {
        field: 'account_id',
        message: errorMessage('recurring.accountUnavailable', lang),
      };
    // deposits W1: a template on a deposit's ledger is refused server-side (only
    // transfers may touch one, and a template creates an expense or an income).
    // The picker is fed by GET /accounts, which hides deposit accounts, so this
    // takes a stale screen — routed to that picker all the same.
    case 'DEPOSIT_ACCOUNT_TRANSFER_ONLY':
      return {
        field: 'account_id',
        message: errorMessage('transaction.depositTransferOnly', lang),
      };
    // Both date rules are ROUTER codes on create AND PATCH (A7), so one case
    // covers both verbs and there is no Pydantic-array arm to unpack. They route
    // to the field the user must change, with the modal open and their typed
    // value kept — START_DATE_TOO_EARLY especially: the PATCH floor is
    // min(watermark, today) and the watermark is server-only state, so this 422
    // is the ONLY place that rule can be stated.
    case 'START_DATE_AFTER_END_DATE':
      return { field: 'start_date', message: errorMessage('recurring.startAfterEnd', lang) };
    case 'START_DATE_TOO_EARLY':
      return { field: 'start_date', message: errorMessage('recurring.startTooEarly', lang) };
    // The bug-signal family (T6, extended). The *_REQUIRED codes fire only on a
    // body the patch builder never sends (it emits no explicit nulls for those
    // NOT NULL columns), and the two ANCHOR codes are unreachable from a UI whose
    // shared schema mirrors the DB CHECK and whose builder never emits the
    // non-matching anchor (WR-9). Reaching any of them means the CLIENT is
    // broken, not the user — so: generic message, form level, no field routing.
    case 'NAME_REQUIRED':
    case 'AMOUNT_REQUIRED':
    case 'KIND_REQUIRED':
    case 'CURRENCY_REQUIRED':
    case 'INTERVAL_UNIT_REQUIRED':
    case 'PAUSED_REQUIRED':
    case 'ANCHOR_REQUIRED':
    case 'ANCHOR_MISMATCH':
      return { field: 'form', message: errorMessage('generic', lang) };
  }

  const issues = getValidationIssues(error.body);
  if (issues) {
    const routed = routeIssue(issues, RECURRING_FIELDS);
    if (routed) return routed;
  }

  return { field: 'form', message: errorMessage('generic', lang) };
}

// --- Category limits (5.4 W4, WR-7) ---------------------------------------
// One field only (`amount_minor`): the CATEGORY is the path, not a form field,
// so every category failure is form-level here — there is nothing to route it to
// and the message has to name the cause itself.

type LimitField = 'amount_minor';
const LIMIT_FIELDS: readonly LimitField[] = ['amount_minor'];

export function describeLimitError(error: unknown, lang: Lang): FieldError<LimitField> {
  if (!(error instanceof ApiError)) {
    return { field: 'form', message: errorMessage('network', lang) };
  }

  switch (getErrorCode(error.body)) {
    // 404 on PUT: the addressed category is gone (or was never the user's — the
    // server keeps the existence oracle shut by answering NOT_FOUND for both).
    case 'CATEGORY_NOT_FOUND':
      return {
        field: 'form',
        message: errorMessage('category.notFound', lang),
      };
    // C4 backstops: the Set/Edit affordance is already gated on
    // `kind === 'expense'` and a non-archived category, so these fire only from a
    // stale screen — the copy still says WHY rather than "something went wrong".
    case 'CATEGORY_NOT_EXPENSE':
      return { field: 'form', message: errorMessage('limit.categoryNotExpense', lang) };
    case 'CATEGORY_ARCHIVED':
      return {
        field: 'form',
        message: errorMessage('limit.categoryArchived', lang),
      };
    // 404 on DELETE — the row is already gone; the mutation's onError refetches
    // the list so it also leaves the screen.
    case 'LIMIT_NOT_FOUND':
      return { field: 'form', message: errorMessage('limit.alreadyGone', lang) };
  }

  const issues = getValidationIssues(error.body);
  if (issues) {
    const routed = routeIssue(issues, LIMIT_FIELDS);
    if (routed) return routed;
  }

  return { field: 'form', message: errorMessage('generic', lang) };
}

// --- Personal access tokens (mcp-server S2) -------------------------------
// The tokens router emits exactly ONE business code — `TOKEN_NOT_FOUND`, shared
// by missing / foreign / already-revoked (the no-oracle 404). The revoke dialog
// is the only caller that can see it, and by then the honest reading is always
// "this token is no longer active", so the copy says that rather than hinting at
// which of the three it was.
//
// `scope` is in the field list purely so a 422 on it lands on the radio group; it
// is a closed enum rendered as two radios, so reaching it means the client sent
// something impossible.

type TokenField = 'name' | 'scope';
const TOKEN_FIELDS: readonly TokenField[] = ['name', 'scope'];

export function describeTokenError(error: unknown, lang: Lang): FieldError<TokenField> {
  if (!(error instanceof ApiError)) {
    return { field: 'form', message: errorMessage('network', lang) };
  }

  if (getErrorCode(error.body) === 'TOKEN_NOT_FOUND') {
    return {
      field: 'form',
      message: errorMessage('token.alreadyRevoked', lang),
    };
  }

  const issues = getValidationIssues(error.body);
  if (issues) {
    const routed = routeIssue(issues, TOKEN_FIELDS);
    if (routed) return routed;
  }

  return { field: 'form', message: errorMessage('generic', lang) };
}

// --- Stats (4.2 W1, WS-6) -------------------------------------------------
// A read screen has no form fields, so every failure is PANEL-level: the helper
// returns a message plus whether a "reset to this month" action makes sense.
//
// `PERIOD_ANCHOR_REQUIRED` is the only business code the stats routes emit, and
// `parsePeriodParams` is total (features/stats/period.ts) — so reaching it means
// the client sent a period it never should have. That is the *_REQUIRED bug-signal
// class (T6): the user gets a generic message, plus the one action that provably
// gets them back to a working screen. It is deliberately NOT routed to a "field",
// because there is no field on a read screen that could fix it.
export type StatsFailure = { message: string; canResetPeriod: boolean };

export function describeStatsError(error: unknown, lang: Lang): StatsFailure {
  if (!(error instanceof ApiError)) {
    return { message: errorMessage('network', lang), canResetPeriod: false };
  }

  if (getErrorCode(error.body) === 'PERIOD_ANCHOR_REQUIRED') {
    return { message: errorMessage('generic', lang), canResetPeriod: true };
  }

  // The other 422 arm (FastAPI's Pydantic array — e.g. a hand-typed malformed
  // `month` that slipped past the parser) is equally a period problem the reset
  // action can clear, and equally has nothing to route to.
  if (getValidationIssues(error.body)) {
    return { message: errorMessage('generic', lang), canResetPeriod: true };
  }

  return { message: errorMessage('generic', lang), canResetPeriod: false };
}

// --- CSV export (4.5 W4) --------------------------------------------------
// No table: the export has no fields and no business codes (read filters do not
// error — D13). This exists so the two shared messages above stay the single
// source of that copy instead of being retyped in the screen.
export function describeExportError(error: unknown, lang: Lang): string {
  return errorMessage(error instanceof ApiError ? 'generic' : 'network', lang);
}

// --- Advisor (4.4 W3, WS-6) -----------------------------------------------
// The advisor panel USED to be the one Russian surface in an otherwise English
// app (grooming ruling R4.2). Since S5 the app has a language, so this table
// follows it like every other: with lang='ru' the binding 4.4 copy renders
// byte-exactly (pinned in errors.test.ts), and an English user finally gets an
// English error line under an answer the model wrote in their language.
// `receiptErrorMessage`'s AI_NOT_CONFIGURED entry stays SEPARATE: the two
// surfaces say different things (there the photo is still saved and the manual
// path is the advice; here nothing was produced at all).
//
// TWO CHANNELS, ONE TABLE (WS-7). A failure reaches this helper either as an
// `ApiError` (the pre-stream 503/429/422) or as a bare DETAIL STRING — the
// mid-stream SSE `error` frame's `detail`, plus askAdvisor's two synthetic codes
// STREAM_INCOMPLETE / STREAM_MALFORMED. A mid-stream failure cannot be an HTTP
// status because the 200 is long gone, which is exactly why both shapes exist.
/**
 * `keepsPartialAnswer` — whether the text already on screen is a REAL partial
 * answer that must stay, with this message rendered as a notice under it. The
 * alternative (a panel-level alert) is for failures that produced nothing.
 */
export type AdvisorFailure = { message: string; keepsPartialAnswer: boolean };

export function describeAdvisorError(error: unknown, lang: Lang): AdvisorFailure {
  const code =
    typeof error === 'string'
      ? error
      : error instanceof ApiError
        ? getErrorCode(error.body)
        : undefined;

  if (code === undefined) {
    // Either a network failure (no ApiError at all) or the 422 arm. Per the
    // upheld ruling the advisor has NO business 422 code — only
    // HTTPValidationError — and the client caps (advisorAskSchema + buildHistory)
    // make it unreachable, so it is a bug signal that gets the generic message,
    // never a field message.
    return {
      message: errorMessage(error instanceof ApiError ? 'generic' : 'network', lang),
      keepsPartialAnswer: false,
    };
  }

  switch (code) {
    // BINDING copy (task.md). Retrying cannot fix a server with no key, and the
    // "Спросить AI" button is never hidden — so the panel says exactly why.
    case 'AI_NOT_CONFIGURED':
      return { message: errorMessage('advisor.aiNotConfigured', lang), keepsPartialAnswer: false };
    // No Retry-After on the wire (CA-1 declined: the limiter ships with
    // headers_enabled=False), so the copy cannot name a delay honestly.
    case 'RATE_LIMITED':
      return {
        message: errorMessage('advisor.rateLimited', lang),
        keepsPartialAnswer: false,
      };
    // Mid-stream: whatever arrived before the failure is a real piece of the
    // answer, so it stays on screen with the notice under it.
    case 'ANTHROPIC_ERROR':
      return {
        message: errorMessage('advisor.anthropicError', lang),
        keepsPartialAnswer: true,
      };
    case 'STREAM_INCOMPLETE':
      return {
        message: errorMessage('advisor.streamIncomplete', lang),
        keepsPartialAnswer: true,
      };
    // A protocol break is a bug signal, not something the user can act on — and
    // NOT a "keep the partial answer" case: we cannot vouch for text that came
    // through a frame we could not parse.
    case 'STREAM_MALFORMED':
      return { message: errorMessage('generic', lang), keepsPartialAnswer: false };
    default:
      return { message: errorMessage('generic', lang), keepsPartialAnswer: false };
  }
}

// --- Receipts (S5) --------------------------------------------------------
// Same shape as the helpers above, WITHOUT the field routing: the capture flow
// has no form fields, so every failure is panel-level. The codes arrive from two
// places and share ONE table:
//   1. HTTP error bodies on POST /receipts and POST /receipts/{id}/parse
//      ({"detail": CODE}, read via getErrorCode);
//   2. the terminal `receipt.error` string on a `failed` poll result — which the
//      contract types as a plain `string | null`, NOT an enum (plan-web contract
//      feedback #6). A server-side rename therefore cannot break the build, only
//      fall through to the generic message; the codes are pinned in prose (D10).
//
// `describeReceiptError` returns the CODE alongside the message because the flow
// hook decides retry granularity from it (R5) — mapping a code to a retry action
// is flow logic, not copy, so it deliberately does not live in this table.
export type ReceiptFailure = { code: string | undefined; message: string };

export function receiptErrorMessage(code: string, lang: Lang): string {
  switch (code) {
    // --- create / parse HTTP codes ---
    case 'RATE_LIMITED':
      return errorMessage('receipt.rateLimited', lang);
    case 'RECEIPT_NOT_FOUND':
      return errorMessage('receipt.notFound', lang);
    case 'RECEIPT_NOT_UPLOADED':
      return errorMessage('receipt.notUploaded', lang);
    case 'RECEIPT_PROCESSING':
      return errorMessage('receipt.processing', lang);
    case 'RECEIPT_ALREADY_PARSED':
      return errorMessage('receipt.alreadyParsed', lang);
    case 'IMAGE_TOO_LARGE':
      return errorMessage('receipt.imageTooLarge', lang);
    case 'STORAGE_UNAVAILABLE':
      return errorMessage('receipt.storageUnavailable', lang);
    // Honest and specific (PM 2026-07-29): this is a SERVER CONFIGURATION state,
    // not a transient hiccup — retrying cannot fix it, so the message names the
    // cause and points at the manual path instead of saying "try again later".
    case 'AI_NOT_CONFIGURED':
      return errorMessage('receipt.aiNotConfigured', lang);
    // --- terminal receipt.error codes (failed status) ---
    case 'NOT_A_RECEIPT':
      return errorMessage('receipt.notAReceipt', lang);
    case 'UNREADABLE_IMAGE':
      return errorMessage('receipt.unreadable', lang);
    case 'INVALID_MODEL_OUTPUT':
      return errorMessage('receipt.invalidOutput', lang);
    case 'ANTHROPIC_ERROR':
      return errorMessage('receipt.anthropicError', lang);
    case 'DOWNLOAD_FAILED':
      return errorMessage('receipt.downloadFailed', lang);
    default:
      return errorMessage('generic', lang);
  }
}

export function describeReceiptError(error: unknown, lang: Lang): ReceiptFailure {
  if (!(error instanceof ApiError)) {
    // Includes the raw PUT to storage: a failed fetch rejects with a TypeError,
    // which is exactly the "can't reach it" case.
    return { code: undefined, message: errorMessage('network', lang) };
  }

  const code = getErrorCode(error.body);
  if (code !== undefined) {
    return { code, message: receiptErrorMessage(code, lang) };
  }

  // The other 422 arm (HTTPValidationError on the uuid path param) is a bug
  // signal, not something the user can act on — generic, and no code to retry on.
  return { code: undefined, message: errorMessage('generic', lang) };
}

// --- Statement imports (statement-import S4) -------------------------------
//
// NOT a `FieldError` table: this flow has no form with named fields. Its writes
// are a file upload, a per-row decision, one batch apply and one destructive
// replace — every failure is about the whole action, so the shape is a
// message plus the CODE, which the screens branch on for what to do NEXT
// (refetch a preview, send the user back to the account picker, offer a retry).
// The `describeReceiptError` precedent, for the same reason.
export type ImportFailure = { code: string | undefined; message: string };

export function importErrorMessage(code: string, lang: Lang): string {
  switch (code) {
    // --- upload ---
    case 'ACCOUNT_NOT_FOUND':
      return errorMessage('statement.accountNotFound', lang);
    case 'ACCOUNT_ARCHIVED':
      return errorMessage('statement.accountArchived', lang);
    case 'STATEMENT_TOO_LARGE':
      return errorMessage('statement.tooLarge', lang);
    case 'STATEMENT_PARSE_FAILED':
      return errorMessage('statement.parseFailed', lang);
    case 'STATEMENT_FORMAT_UNKNOWN':
      return errorMessage('statement.formatUnknown', lang);
    // The GENERIC arm. When the server sent both currencies — which it does for
    // exactly this code (§10.7) — the upload modal shows the sentence that names
    // them, built from `statementCurrencyMismatch` below.
    case 'STATEMENT_CURRENCY_MISMATCH':
      return errorMessage('statement.currencyMismatch', lang);
    case 'RATE_LIMITED':
      return errorMessage('statement.rateLimited', lang);
    // --- the session ---
    case 'IMPORT_NOT_FOUND':
      return errorMessage('statement.importNotFound', lang);
    case 'IMPORT_FINISHED':
      return errorMessage('statement.importFinished', lang);
    // --- one row's decision ---
    case 'DECISION_NEEDS_MATCH':
      return errorMessage('statement.decisionNeedsMatch', lang);
    // Raised by the row PATCH and again by apply: a transfer is ONE row seen
    // from two accounts, so "throw mine away" would erase the other account's
    // history for money this statement cannot see.
    case 'TRANSFER_REPLACE_FORBIDDEN':
      return errorMessage('statement.transferReplaceForbidden', lang);
    // The picker offers live categories only, so both take a stale screen — and
    // they say the same thing to the user, which is what this shared key is.
    case 'CATEGORY_NOT_FOUND':
    case 'CATEGORY_ARCHIVED':
      return errorMessage('categoryUnavailable', lang);
    // --- replace ---
    case 'REPLACE_FROM_OUT_OF_RANGE':
      return errorMessage('statement.replaceFromOutOfRange', lang);
    // As with the currency mismatch: the numbers-naming sentence is built by the
    // replace flow from `replaceConfirmationMismatch` below when the server sent
    // them, and this is what is shown when it did not.
    case 'REPLACE_CONFIRMATION_MISMATCH':
      return errorMessage('statement.replaceConfirmationMismatch', lang);
    default:
      return errorMessage('generic', lang);
  }
}

export function describeImportError(error: unknown, lang: Lang): ImportFailure {
  if (!(error instanceof ApiError)) {
    return { code: undefined, message: errorMessage('network', lang) };
  }

  const code = getErrorCode(error.body);
  if (code !== undefined) {
    return { code, message: importErrorMessage(code, lang) };
  }

  // The other 422 arm (HTTPValidationError — a malformed uuid or a body this
  // client does not send) is a bug signal, not something the user can act on.
  return { code: undefined, message: errorMessage('generic', lang) };
}

/**
 * The two currencies a `STATEMENT_CURRENCY_MISMATCH` carries (§10.7), or `null`
 * when the body did not bring them.
 *
 * A runtime narrow rather than a cast: `ApiError.body` is `unknown`, and the
 * generated 422 is a UNION whose other arm has no such fields. Returning null
 * (instead of guessing) is what lets the caller fall back to the general
 * sentence rather than print "undefined".
 */
export function statementCurrencyMismatch(
  error: unknown,
): { statementCurrency: string; accountCurrency: string } | null {
  if (!(error instanceof ApiError)) return null;
  const body = error.body;
  if (typeof body !== 'object' || body === null) return null;
  const statementCurrency = (body as { statement_currency?: unknown }).statement_currency;
  const accountCurrency = (body as { account_currency?: unknown }).account_currency;
  if (typeof statementCurrency !== 'string' || typeof accountCurrency !== 'string') {
    return null;
  }
  return { statementCurrency, accountCurrency };
}

/**
 * The two counts a `REPLACE_CONFIRMATION_MISMATCH` carries: what the user
 * confirmed, and what the server would really delete right now. Same narrow, and
 * same reason — the flow redraws the warning around the real number instead of
 * asking the user to guess what changed.
 */
export function replaceConfirmationMismatch(
  error: unknown,
): { confirmed: number; actual: number } | null {
  if (!(error instanceof ApiError)) return null;
  const body = error.body;
  if (typeof body !== 'object' || body === null) return null;
  const confirmed = (body as { confirm_deleted_total?: unknown }).confirm_deleted_total;
  const actual = (body as { deleted_total?: unknown }).deleted_total;
  if (typeof confirmed !== 'number' || typeof actual !== 'number') return null;
  return { confirmed, actual };
}
