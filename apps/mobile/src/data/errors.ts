// App-side error layer for category / account / transaction mutations (W2, MOB).
// Reuses the shared, platform-free getErrorCode + the runtime ValidationError[] narrow from
// @budget/api-client and adds stable-code -> field routing tables per resource.
//
// Mirrors apps/web/src/lib/errors.ts for the same codes: the ROUTING (which
// control a code lands on) is this client's concern and lives here, while the
// SENTENCE comes from `errorMessage(key, lang)` in @budget/shared — web and mobile
// show the same words for the same failure, in whichever language is on screen.
// Every helper therefore takes the language explicitly and stays a pure function:
// screens pass `useLang()` at the call site (mobile-catchup-1).
//
// The ONLY structural delta from web is importing ApiError from @budget/api-client
// (mobile has no lib/query re-export). The network arm (flaky mobile networks) is
// preserved for every resource.
import {
  ApiError,
  getErrorCode,
  getValidationIssues,
  routeIssue,
  type FieldError,
} from '@budget/api-client';
import { errorMessage, type Lang } from '@budget/shared';

/**
 * Exported like web's: the one sentence the app uses for "the request never
 * reached the server" has a single home, so a read's retry affordance and a
 * mutation's form error cannot drift apart.
 */
export function networkMessage(lang: Lang): string {
  return errorMessage('network', lang);
}

type CategoryField = 'name' | 'icon' | 'color' | 'kind';
const CATEGORY_FIELDS: readonly CategoryField[] = ['name', 'icon', 'color', 'kind'];

export function describeCategoryError(
  error: unknown,
  lang: Lang,
): FieldError<CategoryField> {
  if (!(error instanceof ApiError)) {
    return { field: 'form', message: errorMessage('network', lang) };
  }

  switch (getErrorCode(error.body)) {
    case 'SYSTEM_CATEGORY_READONLY':
      return { field: 'form', message: errorMessage('category.systemReadonly', lang) };
    case 'CATEGORY_NOT_FOUND':
      return { field: 'form', message: errorMessage('category.notFound', lang) };
    // Fires on rename OR a kind-only PATCH (W2): always a name collision within a
    // kind, so it is always routed to the name field, never a generic failure.
    case 'CATEGORY_NAME_CONFLICT':
      return { field: 'name', message: errorMessage('category.nameConflict', lang) };
  }

  const issues = getValidationIssues(error.body);
  if (issues) {
    const routed = routeIssue(issues, CATEGORY_FIELDS);
    if (routed) return routed;
  }

  return { field: 'form', message: errorMessage('generic', lang) };
}

// --- Accounts (accounts-and-transfers MOB) --------------------------------
// The account form's own failures. `currency` is in the field list although the
// form renders it read-only on edit: a 422 about it is then a bug signal, and
// landing it next to the control the user CAN see beats a silent catch-all.
// Copied from web lib/errors.ts.

type AccountField = 'name' | 'type' | 'currency' | 'starting_balance_minor';
const ACCOUNT_FIELDS: readonly AccountField[] = [
  'name',
  'type',
  'currency',
  'starting_balance_minor',
];

export function describeAccountError(
  error: unknown,
  lang: Lang,
): FieldError<AccountField> {
  if (!(error instanceof ApiError)) {
    return { field: 'form', message: errorMessage('network', lang) };
  }

  switch (getErrorCode(error.body)) {
    // The no-oracle 404: missing and foreign resolve to the same code, and by the
    // time a form sees it the honest reading is always "it is not there any more".
    case 'ACCOUNT_NOT_FOUND':
      return { field: 'form', message: errorMessage('account.notFound', lang) };
    // Fires on a write against an archived account — the copy says what actually
    // unblocks the user.
    case 'ACCOUNT_ARCHIVED':
      return { field: 'form', message: errorMessage('account.archived', lang) };
    // The form makes the currency read-only on edit and the patch builder emits no
    // `currency` key at all, so this is unreachable from a correct client — but it
    // is the ONE rule a user could otherwise spend minutes fighting, so it names
    // the way out instead of "something went wrong".
    case 'ACCOUNT_CURRENCY_IMMUTABLE':
      return { field: 'currency', message: errorMessage('account.currencyImmutable', lang) };
  }

  const issues = getValidationIssues(error.body);
  if (issues) {
    const routed = routeIssue(issues, ACCOUNT_FIELDS);
    if (routed) return routed;
  }

  return { field: 'form', message: errorMessage('generic', lang) };
}

// accounts-and-transfers MOB: the transaction form now carries an account, and the
// TRANSFER form routes through this same helper — its two account fields and its
// second amount are listed so a 422 on one of them lands on the control that can
// fix it rather than on the form root.
// `merchant` joined the list in mobile-catchup-2: the transaction form renders
// that input now, so a 422 naming it has a control to land on (web's list has
// carried it since the same field appeared there).
type TransactionField =
  | 'account_id'
  | 'amount_minor'
  | 'category_id'
  | 'counter_account_id'
  | 'counter_amount_minor'
  | 'occurred_at'
  | 'note'
  | 'merchant'
  // goals (catch-up 3, line C): the plan-item picker is part of this form now, so
  // the codes an attachment can raise belong on it rather than on the form root.
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

export function describeTransactionError(
  error: unknown,
  lang: Lang,
): FieldError<TransactionField> {
  if (!(error instanceof ApiError)) {
    return { field: 'form', message: errorMessage('network', lang) };
  }

  switch (getErrorCode(error.body)) {
    case 'TRANSACTION_NOT_FOUND':
      return { field: 'form', message: errorMessage('transaction.notFound', lang) };
    case 'CATEGORY_NOT_FOUND':
    case 'CATEGORY_ARCHIVED':
      return { field: 'category_id', message: errorMessage('categoryUnavailable', lang) };
    // --- goals (catch-up 3, line C) ------------------------------------------
    // The picker lists live goals and their real nodes, so both of these take a
    // stale screen (the item deleted, or its goal archived, on another device) —
    // routed to the picker, which is the control that can fix them.
    case 'GOAL_ITEM_NOT_FOUND':
      return { field: 'goal_item_id', message: errorMessage('goalItem.notFound', lang) };
    case 'GOAL_ARCHIVED':
      return { field: 'goal_item_id', message: errorMessage('goal.archived', lang) };
    // A BUG SIGNAL, not a user error: the field is rendered on expenses only and
    // is cleared when the kind flips, so the wire cannot carry this pair unless
    // the client is broken. It still says something happened, because the row
    // would otherwise look saved.
    case 'GOAL_ITEM_EXPENSE_ONLY':
      return { field: 'form', message: errorMessage('generic', lang) };
    // --- end goals (catch-up 3, line C) --------------------------------------
    // accounts-and-transfers MOB. Both codes are emitted for the SOURCE account and
    // for a transfer's counter account alike, and the wire does not say which — so
    // they stay form-level: the message names both possibilities honestly rather
    // than blaming the wrong picker. (The account cache is refreshed by the
    // mutation's own invalidation, so re-opening the form shows the real list.)
    case 'ACCOUNT_NOT_FOUND':
      return {
        field: 'form',
        message: errorMessage('transaction.accountUnavailable', lang),
      };
    case 'ACCOUNT_ARCHIVED':
      return { field: 'form', message: errorMessage('transaction.accountArchived', lang) };
    // §4: the server stamps `currency` from the account, and neither the create
    // body nor the patch builder sends a currency at all — so this is a bug
    // signal. It still says what happened, because the number on screen would
    // otherwise look saved.
    case 'ACCOUNT_CURRENCY_MISMATCH':
      return { field: 'form', message: errorMessage('transaction.currencyMismatch', lang) };
    // The transfer form's schema rejects an identical pair before submit, so this
    // takes a stale screen — it is routed to the target picker, the control the
    // user can actually change.
    case 'SAME_ACCOUNT_TRANSFER':
      return {
        field: 'counter_account_id',
        message: errorMessage('transaction.sameAccountTransfer', lang),
      };
    // Converting an operation to or from a transfer is not a PATCH (delete and
    // re-create instead). No UI offers it, so this is a bug signal.
    case 'KIND_CHANGE_UNSUPPORTED':
      return { field: 'form', message: errorMessage('generic', lang) };
    // These only fire from a malformed body the builder never sends — treat as an
    // unexpected-error signal, not a user field error (W2).
    case 'AMOUNT_REQUIRED':
    case 'KIND_REQUIRED':
    case 'OCCURRED_AT_REQUIRED':
      return { field: 'form', message: errorMessage('generic', lang) };
  }

  const issues = getValidationIssues(error.body);
  if (issues) {
    const routed = routeIssue(issues, TRANSACTION_FIELDS);
    if (routed) return routed;
  }

  return { field: 'form', message: errorMessage('generic', lang) };
}

// --- recurring / settings (catch-up 3, line B) -------------------------------
// Recurring templates. Mirror of web's `describeRecurringError`, minus the
// deposit arm (mobile has no deposits screen and its account picker is fed by
// GET /accounts, which hides deposit ledgers): the code cannot be produced from
// any control on this client, so it falls through to the generic form message
// rather than being routed by a case nothing can reach.

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

export function describeRecurringError(
  error: unknown,
  lang: Lang,
): FieldError<RecurringField> {
  if (!(error instanceof ApiError)) {
    return { field: 'form', message: errorMessage('network', lang) };
  }

  switch (getErrorCode(error.body)) {
    case 'RECURRING_TEMPLATE_NOT_FOUND':
      return { field: 'form', message: errorMessage('recurring.notFound', lang) };
    // The category is a BODY field here (the addressed resource is the
    // template), so both codes route to the picker — the transactions rule.
    case 'CATEGORY_NOT_FOUND':
    case 'CATEGORY_ARCHIVED':
      return { field: 'category_id', message: errorMessage('categoryUnavailable', lang) };
    // The template carries an account too, and the same two codes reach this
    // form from the account picker.
    case 'ACCOUNT_NOT_FOUND':
    case 'ACCOUNT_ARCHIVED':
      return {
        field: 'account_id',
        message: errorMessage('recurring.accountUnavailable', lang),
      };
    // Both date rules are ROUTER codes on create AND PATCH, so one case covers
    // both verbs. They route to the field the user must change, with the form
    // open and their typed value kept — START_DATE_TOO_EARLY especially: the
    // PATCH floor is min(watermark, today), the watermark is server-only state,
    // and this 422 is the ONLY place that rule can be stated.
    case 'START_DATE_AFTER_END_DATE':
      return { field: 'start_date', message: errorMessage('recurring.startAfterEnd', lang) };
    case 'START_DATE_TOO_EARLY':
      return { field: 'start_date', message: errorMessage('recurring.startTooEarly', lang) };
    // The bug-signal family: the *_REQUIRED codes fire only on a body the patch
    // builder never sends, and the two ANCHOR codes are unreachable from a form
    // whose shared schema mirrors the DB CHECK. Reaching any of them means the
    // CLIENT is broken, not the user — generic message, form level, no routing.
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
// --- end recurring / settings (catch-up 3, line B) ---------------------------

// --- goals (catch-up 3, line C) ----------------------------------------------
// Copied from web lib/errors.ts. The ROUTING (which control a code lands on) is
// this client's concern; the SENTENCE is the shared one (@budget/shared
// ERROR_MESSAGES), so a goal failure reads identically on both clients.

type GoalField =
  | 'name'
  | 'target_minor'
  | 'currency'
  | 'deadline'
  | 'priority'
  | 'initial_saved_minor'
  | 'initial_budget_minor'
  | 'final_cost_override_minor';
const GOAL_FIELDS: readonly GoalField[] = [
  'name',
  'target_minor',
  'currency',
  'deadline',
  'priority',
  'initial_saved_minor',
  'initial_budget_minor',
  'final_cost_override_minor',
];

export function describeGoalError(error: unknown, lang: Lang): FieldError<GoalField> {
  if (!(error instanceof ApiError)) {
    return { field: 'form', message: errorMessage('network', lang) };
  }

  switch (getErrorCode(error.body)) {
    case 'GOAL_NOT_FOUND':
      return { field: 'form', message: errorMessage('goal.notFound', lang) };
    // The *_REQUIRED family fires only on a body the patch builder never sends
    // (it emits no explicit nulls for these columns) — a bug signal rather than a
    // user field error.
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

export function describeContributionError(
  error: unknown,
  lang: Lang,
): FieldError<ContributionField> {
  if (!(error instanceof ApiError)) {
    return { field: 'form', message: errorMessage('network', lang) };
  }

  switch (getErrorCode(error.body)) {
    // The SUM >= 0 invariant is server-owned (no client re-implementation as a
    // hard gate). It fires on a withdrawal AND on deleting a positive
    // contribution — in the delete confirm the same text renders as the
    // operation error, which is why the message names the goal balance.
    case 'CONTRIBUTION_EXCEEDS_SAVED':
      return { field: 'amount_minor', message: errorMessage('contribution.exceedsSaved', lang) };
    case 'CONTRIBUTION_NOT_FOUND':
      return { field: 'form', message: errorMessage('contribution.notFound', lang) };
    // A contribution write also 404s when the GOAL is gone.
    case 'GOAL_NOT_FOUND':
      return { field: 'form', message: errorMessage('goal.notFound', lang) };
  }

  const issues = getValidationIssues(error.body);
  if (issues) {
    const routed = routeIssue(issues, CONTRIBUTION_FIELDS);
    if (routed) return routed;
  }

  return { field: 'form', message: errorMessage('generic', lang) };
}

// A plan item's own table: its field set (a parent, a second amount in the goal's
// currency, a reminder intent) is disjoint from the goal form's, and the three
// STRUCTURE failures (parent gone / cycle / too deep) all belong on the parent
// picker — the one control that can fix them.
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
    // a stale screen — the copy still names the way out (unarchive).
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
    // The bug-signal family. The form's schema mirrors every one of these rules —
    // exactly one reminder intent, a second amount only for a foreign currency
    // with an amount, and no explicit null for a NOT NULL column — so reaching
    // them means the CLIENT is broken, not the user.
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
// --- end goals (catch-up 3, line C) ------------------------------------------
