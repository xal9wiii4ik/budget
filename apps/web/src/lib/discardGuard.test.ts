import { describe, expect, it } from 'vitest';

import { shouldConfirmDiscard } from './discardGuard';

describe('shouldConfirmDiscard', () => {
  it('confirms only when the form is dirty and nothing is pending', () => {
    expect(shouldConfirmDiscard(true, false)).toBe(true);
  });

  it('lets a CLEAN form close immediately (no nag on an untouched form)', () => {
    expect(shouldConfirmDiscard(false, false)).toBe(false);
  });

  it('does not confirm while a mutation is in flight (closeDisabled)', () => {
    expect(shouldConfirmDiscard(true, true)).toBe(false);
  });
});
