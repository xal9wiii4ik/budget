import { getErrorCode, getValidationIssues, locTailField } from '@budget/api-client';

import type { SimpleKey } from '../i18n/t';
import { ApiError } from '../lib/query';

/** Where an error message should surface in the form. */
export type AuthErrorLevel = 'form' | 'email' | 'password';

export interface AuthErrorDisplay {
  level: AuthErrorLevel;
  /**
   * A DICTIONARY KEY, not a sentence: this module owns the code -> field ROUTING
   * and stays language-free, so the login/register screens render it with `t()`
   * in whichever language is on screen. (These messages are web-only — mobile has
   * its own auth screens — which is why they live in the web dictionary rather
   * than in @budget/shared's ERROR_MESSAGES.)
   */
  messageKey: SimpleKey;
}

/**
 * App-owned code -> copy table over the shared `getErrorCode` (plan E18). The
 * api-client returns the raw stable code; the routing lives here so new codes
 * extend this map without restructuring the narrower. Bad-credentials stays
 * deliberately non-specific (don't reveal which field was wrong).
 */
export function describeAuthError(error: unknown): AuthErrorDisplay {
  // A thrown non-ApiError means fetch itself rejected (no HTTP response) — a
  // network/connectivity failure. Every auth mutation needs a retryable message,
  // never a dead end.
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
      // A3: the shared zod accepts some reserved-TLD emails the server 422s with a
      // Pydantic ValidationError[] (no string code). Route that to the email field
      // rather than a generic form error, reusing the runtime narrow from lib/errors.
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
 * (e.g. transient error or a 429 on the second call). Carries the email so the
 * RegisterPage can hand off to /login with the address prefilled via router
 * location state (AM-8 — never a ?email= query param, PII in URL/history).
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
