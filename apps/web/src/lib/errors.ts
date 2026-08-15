// App-side error layer for category / transaction mutations (obligations C2 / T6 /
// A3). Reuses the shared, platform-free getErrorCode + the runtime ValidationError[]
// narrow from @budget/api-client (the narrow now lives in the package, not here,
// because the generated POST/PATCH 422 type declares {detail:string} and does NOT
// model the Pydantic array FastAPI really returns) and adds stable-code -> field
// routing tables per resource.
import { getErrorCode, getValidationIssues, routeIssue, type FieldError } from '@budget/api-client';

import { ApiError } from './query';

const NETWORK_MESSAGE = "Can't reach the server. Check your connection and try again.";
const GENERIC_MESSAGE = 'Something went wrong. Please try again.';

type CategoryField = 'name' | 'icon' | 'color' | 'kind';
const CATEGORY_FIELDS: readonly CategoryField[] = ['name', 'icon', 'color', 'kind'];

export function describeCategoryError(error: unknown): FieldError<CategoryField> {
  if (!(error instanceof ApiError)) {
    return { field: 'form', message: NETWORK_MESSAGE };
  }

  switch (getErrorCode(error.body)) {
    case 'SYSTEM_CATEGORY_READONLY':
      return { field: 'form', message: "System categories can't be edited." };
    case 'CATEGORY_NOT_FOUND':
      return {
        field: 'form',
        message: 'That category no longer exists. Refresh and try again.',
      };
    // Fires on rename OR a kind-only PATCH (C2): always a name collision within a
    // kind, so it is always routed to the name field, never a generic failure.
    case 'CATEGORY_NAME_CONFLICT':
      return {
        field: 'name',
        message: 'A category with this name already exists in this type.',
      };
  }

  const issues = getValidationIssues(error.body);
  if (issues) {
    const routed = routeIssue(issues, CATEGORY_FIELDS);
    if (routed) return routed;
  }

  return { field: 'form', message: GENERIC_MESSAGE };
}

type TransactionField = 'amount_minor' | 'category_id' | 'occurred_at' | 'note';
const TRANSACTION_FIELDS: readonly TransactionField[] = [
  'amount_minor',
  'category_id',
  'occurred_at',
  'note',
];

export function describeTransactionError(error: unknown): FieldError<TransactionField> {
  if (!(error instanceof ApiError)) {
    return { field: 'form', message: NETWORK_MESSAGE };
  }

  switch (getErrorCode(error.body)) {
    case 'TRANSACTION_NOT_FOUND':
      return {
        field: 'form',
        message: 'This transaction no longer exists. Refresh and try again.',
      };
    case 'CATEGORY_NOT_FOUND':
    case 'CATEGORY_ARCHIVED':
      return {
        field: 'category_id',
        message: 'That category is unavailable. Pick another one.',
      };
    // These only fire from a malformed body the builder never sends — treat as an
    // unexpected-error signal, not a user field error (T6). 3.2 adds the two
    // multi-currency members of the same family: the shared schema nulls
    // base_amount_minor for a base-currency row and the patch builder drops the
    // key whenever the effective currency is the base, so reaching the server
    // with either code is a bug signal, not something the user can fix in a field.
    case 'AMOUNT_REQUIRED':
    case 'KIND_REQUIRED':
    case 'OCCURRED_AT_REQUIRED':
    case 'BASE_AMOUNT_WITHOUT_CURRENCY':
    case 'CURRENCY_REQUIRED':
      return { field: 'form', message: GENERIC_MESSAGE };
  }

  const issues = getValidationIssues(error.body);
  if (issues) {
    const routed = routeIssue(issues, TRANSACTION_FIELDS);
    if (routed) return routed;
  }

  return { field: 'form', message: GENERIC_MESSAGE };
}

// --- Goals (3.2 W3/W4, WD-5) ----------------------------------------------
// Two helpers, not one: a goal form and a contribution dialog have disjoint field
// sets and disjoint failure modes, and a shared catch-all would happily route a
// contribution's CONTRIBUTION_EXCEEDS_SAVED onto a goal field that cannot fix it.

type GoalField = 'name' | 'target_minor' | 'currency' | 'deadline' | 'priority';
const GOAL_FIELDS: readonly GoalField[] = [
  'name',
  'target_minor',
  'currency',
  'deadline',
  'priority',
];

export function describeGoalError(error: unknown): FieldError<GoalField> {
  if (!(error instanceof ApiError)) {
    return { field: 'form', message: NETWORK_MESSAGE };
  }

  switch (getErrorCode(error.body)) {
    case 'GOAL_NOT_FOUND':
      return {
        field: 'form',
        message: 'This goal no longer exists. Refresh and try again.',
      };
    // The *_REQUIRED family fires only on a body the patch builder never sends
    // (it emits no explicit nulls for these columns) — a bug signal rather than a
    // user field error, the T6 precedent.
    case 'NAME_REQUIRED':
    case 'TARGET_REQUIRED':
    case 'CURRENCY_REQUIRED':
    case 'PRIORITY_REQUIRED':
    case 'ARCHIVED_REQUIRED':
      return { field: 'form', message: GENERIC_MESSAGE };
  }

  const issues = getValidationIssues(error.body);
  if (issues) {
    const routed = routeIssue(issues, GOAL_FIELDS);
    if (routed) return routed;
  }

  return { field: 'form', message: GENERIC_MESSAGE };
}

type ContributionField = 'amount_minor' | 'occurred_at' | 'note';
const CONTRIBUTION_FIELDS: readonly ContributionField[] = [
  'amount_minor',
  'occurred_at',
  'note',
];

export function describeContributionError(error: unknown): FieldError<ContributionField> {
  if (!(error instanceof ApiError)) {
    return { field: 'form', message: NETWORK_MESSAGE };
  }

  switch (getErrorCode(error.body)) {
    // The SUM >= 0 invariant is server-owned (C8: no client re-implementation as
    // a hard gate). It fires on a withdrawal AND on deleting a positive
    // contribution — in the delete dialog the same text renders as the operation
    // error, which is why the message names the goal balance, not the field.
    case 'CONTRIBUTION_EXCEEDS_SAVED':
      return {
        field: 'amount_minor',
        message: "That's more than this goal has saved.",
      };
    case 'CONTRIBUTION_NOT_FOUND':
      return {
        field: 'form',
        message: 'This contribution no longer exists. Refresh and try again.',
      };
    // A contribution write also 404s when the GOAL is gone.
    case 'GOAL_NOT_FOUND':
      return {
        field: 'form',
        message: 'This goal no longer exists. Refresh and try again.',
      };
  }

  const issues = getValidationIssues(error.body);
  if (issues) {
    const routed = routeIssue(issues, CONTRIBUTION_FIELDS);
    if (routed) return routed;
  }

  return { field: 'form', message: GENERIC_MESSAGE };
}
