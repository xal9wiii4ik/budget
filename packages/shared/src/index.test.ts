import { describe, it, expect } from 'vitest';
import { PACKAGE_NAME } from './index';

describe('@budget/shared', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@budget/shared');
  });
});
