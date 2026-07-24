import { describe, expect, it } from 'vitest';

import { formatMoney } from '@budget/shared';

describe('monorepo wiring', () => {
  it('resolves and executes @budget/shared across the workspace', () => {
    // Runs under vitest/Node (V8 + full ICU): this proves workspace resolution
    // and execution of @budget/shared from the mobile workspace under its own
    // tsconfig — it does NOT prove Hermes. The running screen (app/index.tsx) is
    // the Hermes/Intl canary.
    expect(formatMoney(12345, 'USD', { locale: 'en-US' })).toBe('$123.45');
  });
});
