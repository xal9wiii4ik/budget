import { ApiError } from '@budget/api-client';
import { describe, expect, it } from 'vitest';

import { describeCategoryError, describeTransactionError } from './errors';

describe('describeCategoryError', () => {
  it('routes a 409 name conflict to the name field', () => {
    const result = describeCategoryError(new ApiError(409, { detail: 'CATEGORY_NAME_CONFLICT' }));
    expect(result.field).toBe('name');
  });

  it('routes a system-category readonly error to the form', () => {
    const result = describeCategoryError(new ApiError(403, { detail: 'SYSTEM_CATEGORY_READONLY' }));
    expect(result.field).toBe('form');
  });

  it('NETWORK ARM: a non-ApiError yields the retryable connection message at form level', () => {
    const result = describeCategoryError(new TypeError('Network request failed'));
    expect(result.field).toBe('form');
    expect(result.message).toBe("Can't reach the server. Check your connection and try again.");
  });
});

describe('describeTransactionError', () => {
  it('routes CATEGORY_ARCHIVED to the category_id field', () => {
    const result = describeTransactionError(new ApiError(422, { detail: 'CATEGORY_ARCHIVED' }));
    expect(result.field).toBe('category_id');
  });

  it('routes AMOUNT_REQUIRED to the form (unexpected-error fallback, not a field error)', () => {
    // Contrast with CATEGORY_ARCHIVED above: a *_REQUIRED code only fires from a body
    // the builder never sends, so it is a generic form error, not a field message.
    const result = describeTransactionError(new ApiError(422, { detail: 'AMOUNT_REQUIRED' }));
    expect(result.field).toBe('form');
  });

  it('NETWORK ARM: a non-ApiError yields the retryable connection message at form level', () => {
    const result = describeTransactionError(new TypeError('Network request failed'));
    expect(result.field).toBe('form');
    expect(result.message).toBe("Can't reach the server. Check your connection and try again.");
  });
});
