import { describe, expect, it } from 'vitest';

import {
  describeCategoryError,
  describeTransactionError,
  getValidationIssues,
} from './errors';
import { ApiError } from './query';

describe('getValidationIssues — runtime narrow of the 422 body', () => {
  it('returns undefined for the string-code arm ({detail: string})', () => {
    expect(getValidationIssues({ detail: 'CATEGORY_NAME_CONFLICT' })).toBeUndefined();
  });

  it('returns issues for the ValidationError[] arm', () => {
    const body = {
      detail: [{ loc: ['body', 'note'], msg: 'too long', type: 'string_too_long' }],
    };
    expect(getValidationIssues(body)).toEqual([{ loc: ['body', 'note'], msg: 'too long' }]);
  });

  it('returns undefined for an object detail (neither string nor array)', () => {
    expect(getValidationIssues({ detail: { code: 'X', reason: 'y' } })).toBeUndefined();
  });
});

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
