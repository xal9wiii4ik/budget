import { describe, expect, it } from 'vitest';

import { PACKAGE_NAME } from '@budget/shared';

describe('monorepo wiring', () => {
  it('resolves and executes @budget/shared across the workspace', () => {
    expect(PACKAGE_NAME).toBe('@budget/shared');
  });
});
