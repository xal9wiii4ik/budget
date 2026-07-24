import { ApiError } from '@budget/api-client';
import { describe, expect, it } from 'vitest';

import { describeAuthError } from './errors';

describe('describeAuthError', () => {
  it('routes bad credentials to a non-specific form message (no field disclosure)', () => {
    const result = describeAuthError(new ApiError(401, { detail: 'LOGIN_BAD_CREDENTIALS' }));
    expect(result.level).toBe('form');
    expect(result.message).toBe('Incorrect email or password.');
  });

  it('routes a duplicate registration to the email field', () => {
    const result = describeAuthError(
      new ApiError(400, { detail: 'REGISTER_USER_ALREADY_EXISTS' }),
    );
    expect(result.level).toBe('email');
  });

  it('routes an invalid password to the password field', () => {
    const result = describeAuthError(
      new ApiError(400, { detail: { code: 'REGISTER_INVALID_PASSWORD', reason: 'too short' } }),
    );
    expect(result.level).toBe('password');
  });

  it('routes a Pydantic email ValidationError[] (no code) to the email field', () => {
    const result = describeAuthError(
      new ApiError(422, { detail: [{ loc: ['body', 'email'], msg: 'invalid' }] }),
    );
    expect(result.level).toBe('email');
  });

  it('NETWORK ARM: a non-ApiError (fetch rejected) yields a retryable connection message', () => {
    // Contrast with every ApiError arm above: no HTTP response at all -> the network
    // copy, at form level, so the mutation is recoverable rather than a dead end (O7).
    const result = describeAuthError(new TypeError('Network request failed'));
    expect(result.level).toBe('form');
    expect(result.message).toBe(
      "Can't reach the server. Check your connection and try again.",
    );
  });
});
