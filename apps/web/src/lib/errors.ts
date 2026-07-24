// App-side error layer for category / transaction mutations (obligations C2 / T6 /
// A3). Reuses the shared, platform-free `getErrorCode` from the api-client (which
// narrows the {detail:string} arm) and adds:
//   - a RUNTIME narrow of the 422 body's ValidationError[] arm, because the
//     generated POST/PATCH 422 type declares `{detail:string}` and does NOT model
//     the Pydantic array that FastAPI really returns (T6). We do not trust the
//     generated type as exhaustive; we narrow the value itself.
//   - stable-code -> field routing tables for each resource.
import { getErrorCode } from '@budget/api-client';

import { ApiError } from './query';

const NETWORK_MESSAGE = "Can't reach the server. Check your connection and try again.";
const GENERIC_MESSAGE = 'Something went wrong. Please try again.';

export interface ValidationIssue {
  loc: (string | number)[];
  msg: string;
}

/** Where a mutation error should surface: a named form field, or the form root. */
export type FieldError<F extends string> = { field: F | 'form'; message: string };

/**
 * Runtime narrow of a parsed error body to FastAPI's ValidationError[] arm.
 * Returns the issues when `detail` is a non-empty array of `{loc, msg}`; returns
 * `undefined` for the string-code arm, an object detail, or a non-object body.
 */
export function getValidationIssues(body: unknown): ValidationIssue[] | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const detail = (body as { detail?: unknown }).detail;
  if (!Array.isArray(detail)) return undefined;

  const issues: ValidationIssue[] = [];
  for (const raw of detail) {
    if (typeof raw !== 'object' || raw === null) continue;
    const loc = (raw as { loc?: unknown }).loc;
    const msg = (raw as { msg?: unknown }).msg;
    if (Array.isArray(loc) && typeof msg === 'string') {
      const cleanLoc = loc.filter(
        (p): p is string | number => typeof p === 'string' || typeof p === 'number',
      );
      issues.push({ loc: cleanLoc, msg });
    }
  }
  return issues.length > 0 ? issues : undefined;
}

/**
 * The trailing STRING segment of a ValidationError `loc` (the field name), ignoring
 * the leading `"body"` wrapper FastAPI prepends. Returns `undefined` when the loc
 * carries no field-level segment (e.g. a whole-body error).
 */
export function locTailField(loc: (string | number)[]): string | undefined {
  for (let i = loc.length - 1; i >= 0; i -= 1) {
    const part = loc[i];
    if (typeof part === 'string' && part !== 'body') return part;
  }
  return undefined;
}

// Finds the first issue whose loc tail maps to one of `fields`, returning the
// mapped field + its server message.
function routeIssue<F extends string>(
  issues: ValidationIssue[],
  fields: readonly F[],
): FieldError<F> | undefined {
  for (const issue of issues) {
    const tail = locTailField(issue.loc);
    if (tail && (fields as readonly string[]).includes(tail)) {
      return { field: tail as F, message: issue.msg };
    }
  }
  return undefined;
}

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
