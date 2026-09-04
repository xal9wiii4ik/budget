// App-owned auth error ROUTING over the shared getErrorCode (O7). Mobile MUST
// include the network arm: flaky mobile networks mean fetch itself can reject with
// no HTTP response, and every auth mutation needs a visible, retryable message —
// never a dead end. Copied from web auth/errors.ts; the ONLY delta is importing
// ApiError from @budget/api-client (mobile has no lib/query re-export).
import {
  ApiError,
  getErrorCode,
  getValidationIssues,
  locTailField,
} from '@budget/api-client';

import type { SimpleKey } from '../i18n/t';

/** Where an error message should surface in the form. */
export type AuthErrorLevel = 'form' | 'email' | 'password';

export interface AuthErrorDisplay {
  level: AuthErrorLevel;
  /**
   * A DICTIONARY KEY, not a sentence: this module owns the code -> field ROUTING
   * and stays language-free, so the login/register screens render it with `t()` in
   * whichever language is on screen. (These messages are mobile's own — web has
   * its own auth screens — which is why they live in this app's dictionary rather
   * than in @budget/shared's ERROR_MESSAGES.)
   */
  messageKey: SimpleKey;
}

/**
 * Code -> key table over the shared getErrorCode. The api-client returns the raw
 * stable code; the routing lives here so new codes extend this map without
 * restructuring the narrower. Bad-credentials stays deliberately non-specific
 * (don't reveal which field was wrong).
 */
export function describeAuthError(error: unknown): AuthErrorDisplay {
  // A thrown non-ApiError means fetch itself rejected (no HTTP response) — a
  // network/connectivity failure.
  if (!(error instanceof ApiError)) {
    return { level: 'form', messageKey: 'authError.network' };
  }

  const code = getErrorCode(error.body);
  switch (code) {
    case 'LOGIN_BAD_CREDENTIALS':
      return { level: 'form', messageKey: 'authError.badCredentials' };
    case 'REGISTER_USER_ALREADY_EXISTS':
      return { level: 'email', messageKey: 'authError.emailExists' };
    case 'REGISTER_INVALID_PASSWORD':
      return { level: 'password', messageKey: 'authError.invalidPassword' };
    case 'RATE_LIMITED':
      return { level: 'form', messageKey: 'authError.rateLimited' };
    default: {
      // The shared zod accepts some reserved-TLD emails the server 422s with a
      // Pydantic ValidationError[] (no string code). Route that to the email field
      // rather than a generic form error, reusing the runtime narrow.
      const issues = getValidationIssues(error.body);
      if (issues?.some((issue) => locTailField(issue.loc) === 'email')) {
        return { level: 'email', messageKey: 'authError.invalidEmail' };
      }
      if (error.status === 429) {
        return { level: 'form', messageKey: 'authError.rateLimited' };
      }
      return { level: 'form', messageKey: 'authError.generic' };
    }
  }
}

/**
 * Register succeeded (the account exists) but the auto-chained login leg failed
 * (transient error / 429 on the second call). Carries the email so the register
 * screen hands off to /login prefilled — it does NOT re-register.
 */
export class RegisterLoginFailedError extends Error {
  readonly email: string;
  override readonly cause: unknown;

  constructor(email: string, cause: unknown) {
    super('Account created, but automatic sign-in failed.');
    this.name = 'RegisterLoginFailedError';
    this.email = email;
    this.cause = cause;
  }
}
