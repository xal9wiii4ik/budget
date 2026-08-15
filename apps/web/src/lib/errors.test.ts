import { describe, expect, it } from 'vitest';

import {
  describeCategoryError,
  describeContributionError,
  describeGoalError,
  describeTransactionError,
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
