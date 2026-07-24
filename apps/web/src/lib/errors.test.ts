import { describe, expect, it } from 'vitest';

import { describeCategoryError, describeTransactionError } from './errors';
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
