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
  | 'merchant';
const TRANSACTION_FIELDS: readonly TransactionField[] = [
  'account_id',
  'amount_minor',
  'category_id',
  'counter_account_id',
  'counter_amount_minor',
  'occurred_at',
  'note',
  'merchant',
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
