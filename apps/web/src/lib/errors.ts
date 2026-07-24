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
    // unexpected-error signal, not a user field error (T6).
    case 'AMOUNT_REQUIRED':
    case 'KIND_REQUIRED':
    case 'OCCURRED_AT_REQUIRED':
      return { field: 'form', message: GENERIC_MESSAGE };
  }

  const issues = getValidationIssues(error.body);
  if (issues) {
    const routed = routeIssue(issues, TRANSACTION_FIELDS);
    if (routed) return routed;
  }

  return { field: 'form', message: GENERIC_MESSAGE };
}
