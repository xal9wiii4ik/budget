import { ApiError } from '@budget/api-client';
import { errorMessage } from '@budget/shared';
import { describe, expect, it } from 'vitest';

import {
  describeAccountError,
  describeCategoryError,
  describeTransactionError,
} from './errors';

describe('describeCategoryError', () => {
  it('routes a 409 name conflict to the name field', () => {
    const result = describeCategoryError(
      new ApiError(409, { detail: 'CATEGORY_NAME_CONFLICT' }),
      'en',
    );
    expect(result.field).toBe('name');
  });

  it('routes a system-category readonly error to the form', () => {
    const result = describeCategoryError(
      new ApiError(403, { detail: 'SYSTEM_CATEGORY_READONLY' }),
      'en',
    );
    expect(result.field).toBe('form');
  });

  it('NETWORK ARM: a non-ApiError yields the retryable connection message at form level', () => {
    const result = describeCategoryError(new TypeError('Network request failed'), 'en');
    expect(result.field).toBe('form');
    expect(result.message).toBe(errorMessage('network', 'en'));
  });
});

describe('describeTransactionError', () => {
  it('routes CATEGORY_ARCHIVED to the category_id field', () => {
    const result = describeTransactionError(
      new ApiError(422, { detail: 'CATEGORY_ARCHIVED' }),
      'en',
    );
    expect(result.field).toBe('category_id');
  });

  it('routes AMOUNT_REQUIRED to the form (unexpected-error fallback, not a field error)', () => {
    // Contrast with CATEGORY_ARCHIVED above: a *_REQUIRED code only fires from a body
    // the builder never sends, so it is a generic form error, not a field message.
    const result = describeTransactionError(
      new ApiError(422, { detail: 'AMOUNT_REQUIRED' }),
      'en',
    );
    expect(result.field).toBe('form');
  });

  it('NETWORK ARM: a non-ApiError yields the retryable connection message at form level', () => {
    const result = describeTransactionError(new TypeError('Network request failed'), 'en');
    expect(result.field).toBe('form');
    expect(result.message).toBe(errorMessage('network', 'en'));
  });
});

describe('describeAccountError', () => {
  it('routes ACCOUNT_CURRENCY_IMMUTABLE to the currency field', () => {
    const result = describeAccountError(
      new ApiError(422, { detail: 'ACCOUNT_CURRENCY_IMMUTABLE' }),
      'en',
    );
    expect(result.field).toBe('currency');
  });

  it('routes the no-oracle ACCOUNT_NOT_FOUND to the form, not to a field', () => {
    // Contrast with the currency code above: nothing on this form can fix a
    // vanished account, so there is no control to blame.
    const result = describeAccountError(
      new ApiError(404, { detail: 'ACCOUNT_NOT_FOUND' }),
      'en',
    );
    expect(result.field).toBe('form');
  });
});

describe('describeTransactionError — account codes', () => {
  it('routes SAME_ACCOUNT_TRANSFER to the target account field', () => {
    const result = describeTransactionError(
      new ApiError(422, { detail: 'SAME_ACCOUNT_TRANSFER' }),
      'en',
    );
    expect(result.field).toBe('counter_account_id');
  });

  it('keeps ACCOUNT_ARCHIVED at form level — the wire does not say WHICH account', () => {
    // Contrast with SAME_ACCOUNT_TRANSFER above, which names a control: this code
    // is emitted for the source and the counter account alike, so blaming either
    // picker would be a guess.
    const result = describeTransactionError(
      new ApiError(422, { detail: 'ACCOUNT_ARCHIVED' }),
      'en',
    );
    expect(result.field).toBe('form');
  });
});

describe('the copy comes from the shared dictionary, in the language asked for', () => {
  // The routing above is this client's; the SENTENCE is @budget/shared's, so the
  // same failure reads identically on web. One contrast is enough to pin that the
  // `lang` argument reaches `errorMessage` instead of a hardcoded English string
  // (the state this module was in before mobile-catchup-1).
  it('answers the same code in ru and in en', () => {
    const code = new ApiError(422, { detail: 'ACCOUNT_CURRENCY_MISMATCH' });
    const en = describeTransactionError(code, 'en');
    const ru = describeTransactionError(code, 'ru');

    expect(en.message).toBe(errorMessage('transaction.currencyMismatch', 'en'));
    expect(ru.message).toBe(errorMessage('transaction.currencyMismatch', 'ru'));
    expect(ru.message).not.toBe(en.message);
    // Same routing either way — the language must not change which control the
    // message lands on.
    expect(ru.field).toBe(en.field);
  });
});
