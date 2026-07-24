// App-side error layer for category / transaction mutations (W2). Reuses the
// shared, platform-free getErrorCode + the runtime ValidationError[] narrow from
// @budget/api-client and adds stable-code -> field routing tables per resource.
// Copied from web lib/errors.ts; the ONLY delta is importing ApiError from
// @budget/api-client (mobile has no lib/query re-export). The network arm (flaky
// mobile networks) is preserved for both resources.
import {
  ApiError,
  getErrorCode,
  getValidationIssues,
  routeIssue,
  type FieldError,
} from '@budget/api-client';

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
    // Fires on rename OR a kind-only PATCH (W2): always a name collision within a
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
    // unexpected-error signal, not a user field error (W2).
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
