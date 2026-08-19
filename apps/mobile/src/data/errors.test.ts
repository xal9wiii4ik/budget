import { ApiError } from '@budget/api-client';
import { describe, expect, it } from 'vitest';

import {
  describeAccountError,
  describeCategoryError,
  describeTransactionError,
} from './errors';

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

describe('describeAccountError', () => {
  it('routes ACCOUNT_CURRENCY_IMMUTABLE to the currency field', () => {
    const result = describeAccountError(
      new ApiError(422, { detail: 'ACCOUNT_CURRENCY_IMMUTABLE' }),
    );
    expect(result.field).toBe('currency');
  });

  it('routes the no-oracle ACCOUNT_NOT_FOUND to the form, not to a field', () => {
    // Contrast with the currency code above: nothing on this form can fix a
    // vanished account, so there is no control to blame.
    const result = describeAccountError(new ApiError(404, { detail: 'ACCOUNT_NOT_FOUND' }));
    expect(result.field).toBe('form');
  });
});

describe('describeTransactionError — account codes', () => {
  it('routes SAME_ACCOUNT_TRANSFER to the target account field', () => {
    const result = describeTransactionError(
      new ApiError(422, { detail: 'SAME_ACCOUNT_TRANSFER' }),
    );
    expect(result.field).toBe('counter_account_id');
  });

  it('keeps ACCOUNT_ARCHIVED at form level — the wire does not say WHICH account', () => {
    // Contrast with SAME_ACCOUNT_TRANSFER above, which names a control: this code
    // is emitted for the source and the counter account alike, so blaming either
    // picker would be a guess.
    const result = describeTransactionError(new ApiError(422, { detail: 'ACCOUNT_ARCHIVED' }));
    expect(result.field).toBe('form');
  });

  it('keeps ACCOUNT_CURRENCY_MISMATCH at form level and says what happened', () => {
    const result = describeTransactionError(
      new ApiError(422, { detail: 'ACCOUNT_CURRENCY_MISMATCH' }),
    );
    expect(result.field).toBe('form');
    expect(result.message).toContain("account's currency");
  });
});
