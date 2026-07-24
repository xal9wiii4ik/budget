import { describe, expect, it } from 'vitest';

import { getValidationIssues } from './errors';

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
