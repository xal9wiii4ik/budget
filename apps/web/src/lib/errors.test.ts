import { describe, expect, it } from 'vitest';

import {
  describeCategoryError,
  describeContributionError,
  describeGoalError,
  describeReceiptError,
  describeTransactionError,
  receiptErrorMessage,
} from './errors';
import { ApiError } from './query';

describe('describeCategoryError', () => {
  it('routes a 409 name conflict to the name field', () => {
    const result = describeCategoryError(
      new ApiError(409, { detail: 'CATEGORY_NAME_CONFLICT' }),
    );
    expect(result.field).toBe('name');
  });
});

describe('describeTransactionError', () => {
  it('routes CATEGORY_ARCHIVED to the category_id field', () => {
    const result = describeTransactionError(
      new ApiError(422, { detail: 'CATEGORY_ARCHIVED' }),
    );
    expect(result.field).toBe('category_id');
  });

  it('routes AMOUNT_REQUIRED to the form (unexpected-error fallback)', () => {
    const result = describeTransactionError(new ApiError(422, { detail: 'AMOUNT_REQUIRED' }));
    expect(result.field).toBe('form');
  });
});

describe('describeTransactionError (3.2 multi-currency codes)', () => {
  it('routes BASE_AMOUNT_WITHOUT_CURRENCY to the form, never to a field', () => {
    // The builder/schema make this unreachable — it is a bug signal, so it must
    // NOT be shown on the amount field as if the user mistyped something.
    const result = describeTransactionError(
      new ApiError(422, { detail: 'BASE_AMOUNT_WITHOUT_CURRENCY' }),
    );
    expect(result.field).toBe('form');
  });

  it('routes CURRENCY_REQUIRED to the form (same family)', () => {
    const result = describeTransactionError(
      new ApiError(422, { detail: 'CURRENCY_REQUIRED' }),
    );
    expect(result.field).toBe('form');
  });
});

describe('describeTransactionError (S6 confirm)', () => {
  it('maps RECEIPT_NOT_FOUND to its own form message, not the generic fallback', () => {
    // Same field ('form') as the generic case, so the message is what proves the
    // code is actually mapped — a create whose receipt vanished must say so.
    const result = describeTransactionError(new ApiError(422, { detail: 'RECEIPT_NOT_FOUND' }));
    const generic = describeTransactionError(new ApiError(422, { detail: 'UNMAPPED_CODE' }));
    expect(result.field).toBe('form');
    expect(result.message).toMatch(/receipt/i);
    expect(result.message).not.toBe(generic.message);
  });

  it('routes a 422 on merchant to the merchant input', () => {
    // The confirm form renders that input, so the server's complaint belongs on
    // it rather than in the form-level catch-all.
    const result = describeTransactionError(
      new ApiError(422, {
        detail: [{ loc: ['body', 'merchant'], msg: 'merchant must be at most 255 characters' }],
      }),
    );
    expect(result.field).toBe('merchant');
  });
});

describe('describeGoalError (3.2 W3)', () => {
  it('routes GOAL_NOT_FOUND to the form', () => {
    const result = describeGoalError(new ApiError(404, { detail: 'GOAL_NOT_FOUND' }));
    expect(result.field).toBe('form');
    expect(result.message).toMatch(/no longer exists/i);
  });

  it('routes a 422 field issue to the named goal field', () => {
    const result = describeGoalError(
      new ApiError(422, {
        detail: [{ loc: ['body', 'target_minor'], msg: 'Input should be >= 1' }],
      }),
    );
    expect(result.field).toBe('target_minor');
  });

  it('does NOT claim a contribution error as its own (no copy-paste catch-all)', () => {
    // CONTRIBUTION_EXCEEDS_SAVED belongs to describeContributionError and has no
    // goal field that could fix it; the goal helper must fall through to generic.
    const result = describeGoalError(
      new ApiError(422, { detail: 'CONTRIBUTION_EXCEEDS_SAVED' }),
    );
    expect(result.field).toBe('form');
    expect(result.message).not.toMatch(/saved/i);
  });
});

describe('describeContributionError (3.2 W4)', () => {
  it('routes CONTRIBUTION_EXCEEDS_SAVED to the amount field', () => {
    const result = describeContributionError(
      new ApiError(422, { detail: 'CONTRIBUTION_EXCEEDS_SAVED' }),
    );
    expect(result.field).toBe('amount_minor');
    expect(result.message).toMatch(/saved/i);
  });

  it('surfaces CONTRIBUTION_NOT_FOUND at row/dialog level, not on a field', () => {
    const result = describeContributionError(
      new ApiError(404, { detail: 'CONTRIBUTION_NOT_FOUND' }),
    );
    expect(result.field).toBe('form');
    expect(result.message).toMatch(/no longer exists/i);
  });
});

describe('receiptErrorMessage (S5 taxonomy)', () => {
  // The binding requirement (PM 2026-07-29): the local API deliberately runs
  // without an AI key, so this is the code the user meets FIRST. It must name the
  // real cause — an unconfigured server key — and it must not be the generic
  // message or a vague "not available right now".
  it('names the missing server AI key explicitly', () => {
    const message = receiptErrorMessage('AI_NOT_CONFIGURED');
    expect(message).toMatch(/\bAI\b/);
    expect(message).toMatch(/key/i);
    expect(message).toMatch(/server/i);
    expect(message).not.toBe(receiptErrorMessage('SOMETHING_ELSE'));
  });

  it('separates the model verdicts a user can act on differently', () => {
    // "not a receipt" (take a different route) vs "unreadable" (retake the same
    // photo better) are different instructions — a shared message would be a lie.
    const notAReceipt = receiptErrorMessage('NOT_A_RECEIPT');
    const unreadable = receiptErrorMessage('UNREADABLE_IMAGE');
    expect(notAReceipt).not.toBe(unreadable);
    expect(notAReceipt).toMatch(/manually/i);
    expect(unreadable).toMatch(/clearer/i);
  });

  it('falls back to the generic message for an unknown code', () => {
    // `receipt.error` is an untyped string on the contract, so an unmapped code
    // must degrade to something safe rather than render a raw server token.
    const unknown = receiptErrorMessage('SOME_FUTURE_CODE');
    expect(unknown).not.toMatch(/SOME_FUTURE_CODE/);
    expect(unknown).toBe(receiptErrorMessage('ANOTHER_UNMAPPED_CODE'));
  });
});

describe('describeReceiptError', () => {
  it('extracts the code from an ApiError body and maps its message', () => {
    const result = describeReceiptError(new ApiError(409, { detail: 'RECEIPT_NOT_UPLOADED' }));
    expect(result.code).toBe('RECEIPT_NOT_UPLOADED');
    expect(result.message).toBe(receiptErrorMessage('RECEIPT_NOT_UPLOADED'));
  });

  it('reports the network failure of a raw storage PUT, with no code to retry on', () => {
    // The presigned PUT rejects with a TypeError, not an ApiError.
    const result = describeReceiptError(new TypeError('Failed to fetch'));
    expect(result.code).toBeUndefined();
    expect(result.message).toMatch(/reach the server/i);
  });

  it('does not invent a code for the 422 validation arm', () => {
    // The anyOf union's HTTPValidationError side has no string code: it is a bug
    // signal, so it must land on generic — and must NOT be mistaken for a
    // retryable receipt code.
    const result = describeReceiptError(
      new ApiError(422, { detail: [{ loc: ['path', 'receipt_id'], msg: 'not a valid uuid' }] }),
    );
    expect(result.code).toBeUndefined();
    expect(result.message).not.toMatch(/uuid/i);
  });
});
