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

// `merchant` (S6) is create-only and exists on the confirm form alone; it is
// listed so a 422 on it lands on that input instead of the form-level catch-all.
type TransactionField = 'amount_minor' | 'category_id' | 'occurred_at' | 'note' | 'merchant';
const TRANSACTION_FIELDS: readonly TransactionField[] = [
  'amount_minor',
  'category_id',
  'occurred_at',
  'note',
  'merchant',
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
    // S6: create with a `receipt_id` the server can no longer resolve. Nothing in
    // this scope can delete a receipt (no DELETE endpoint, D12), so it takes a
    // vanished row to fire — but it is mapped honestly instead of falling through
    // to "something went wrong". There is no way to unattach the photo from this
    // form, so the message says what actually gets the transaction saved.
    case 'RECEIPT_NOT_FOUND':
      return {
        field: 'form',
        message:
          'This receipt is no longer available, so it can’t be attached. ' +
          'Close this and add the transaction manually.',
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

export function receiptErrorMessage(code: string): string {
  switch (code) {
    // --- create / parse HTTP codes ---
    case 'RATE_LIMITED':
      return "You've hit the limit for now. Wait a minute and try again.";
    case 'RECEIPT_NOT_FOUND':
      return 'This receipt is no longer available. Pick a photo again.';
    case 'RECEIPT_NOT_UPLOADED':
      return "The photo didn't finish uploading. Try again.";
    case 'RECEIPT_PROCESSING':
      return 'This receipt is already being read.';
    case 'RECEIPT_ALREADY_PARSED':
      return 'This receipt has already been read.';
    case 'IMAGE_TOO_LARGE':
      return 'That image is too large. Pick a smaller photo.';
    case 'STORAGE_UNAVAILABLE':
      return 'Photo storage is unavailable right now. Try again in a moment.';
    // Honest and specific (PM 2026-07-29): this is a SERVER CONFIGURATION state,
    // not a transient hiccup — retrying cannot fix it, so the message names the
    // cause and points at the manual path instead of saying "try again later".
    case 'AI_NOT_CONFIGURED':
      return (
        'AI reading is unavailable: no AI key is configured on the server. ' +
        'The photo is saved — add the transaction manually and it stays attached.'
      );
    // --- terminal receipt.error codes (failed status) ---
    case 'NOT_A_RECEIPT':
      return "That photo doesn't look like a receipt. You can add the transaction manually.";
    case 'UNREADABLE_IMAGE':
      return "Couldn't read the receipt. Try a clearer, well-lit photo.";
    case 'INVALID_MODEL_OUTPUT':
      return "Couldn't make sense of this one. Try again, or add the transaction manually.";
    case 'ANTHROPIC_ERROR':
      return 'Reading the receipt failed. Try again in a moment.';
    case 'DOWNLOAD_FAILED':
      return 'Something went wrong reading the uploaded photo. Try again.';
    default:
      return GENERIC_MESSAGE;
  }
}

export function describeReceiptError(error: unknown): ReceiptFailure {
  if (!(error instanceof ApiError)) {
    // Includes the raw PUT to storage: a failed fetch rejects with a TypeError,
    // which is exactly the "can't reach it" case.
    return { code: undefined, message: NETWORK_MESSAGE };
  }

  const code = getErrorCode(error.body);
  if (code !== undefined) {
    return { code, message: receiptErrorMessage(code) };
  }

  // The other 422 arm (HTTPValidationError on the uuid path param) is a bug
  // signal, not something the user can act on — generic, and no code to retry on.
  return { code: undefined, message: GENERIC_MESSAGE };
}
