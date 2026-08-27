import { describe, expect, it } from 'vitest';

import type { DepositRead } from '../../data/deposits';
import { depositRowState } from './depositStatus';

function deposit(overrides: Partial<DepositRead> = {}): DepositRead {
  return {
    id: 'dep-1',
    name: 'Bank deposit',
    account_id: 'acc-deposit-1',
    currency: 'BYN',
    rate_percent: '10.95',
    capitalization: 'monthly',
    opened_on: '2025-08-01',
    term_end: '2026-09-01',
    tax_rate_percent: null,
    balance_minor: 500000,
    accrued_minor: 4200,
    accrued_after_tax_minor: null,
    accrued_override_minor: null,
    accrued_override_as_of: null,
    status: 'active',
    archived: false,
    created_at: '2026-08-01T10:00:00Z',
  ...overrides,
  };
}

describe('depositRowState', () => {
  it('badges a ZERO manual anchor as edited by hand', () => {
    // The trap this module exists for: 0 is a legitimate anchor ("the bank says
    // nothing has accrued"), and a truthiness check would hide the badge and the
    // reset button on exactly the row that most needs explaining.
    const state = depositRowState(
      deposit({ accrued_override_minor: 0, accrued_override_as_of: '2026-08-27' }),
    );

    expect(state.isOverridden).toBe(true);
    expect(state.badges).toEqual(['overridden']);
  });

  it('shows a ZERO after-tax figure and hides an absent one', () => {
    // Same trap on the other field: `null` means "not taxed" and shows nothing,
    // while 0 is a real "nothing left after tax" figure that must render.
    expect(depositRowState(deposit({ accrued_after_tax_minor: 0 })).showAfterTax).toBe(true);
    expect(depositRowState(deposit({ accrued_after_tax_minor: null })).showAfterTax).toBe(
      false,
    );
  });

  it('lets a matured deposit still move money, but a closed one neither', () => {
    // The term ending does not lock the money away — closing the deposit IS a
    // transfer back — while archiving does, and it also closes the terms to
    // edits (two different server guards, same input).
    const matured = depositRowState(deposit({ status: 'matured' }));
    expect(matured.badges).toEqual(['matured']);
    expect(matured.canMoveMoney).toBe(true);
    expect(matured.canEditTerms).toBe(true);

    const closed = depositRowState(deposit({ status: 'matured', archived: true }));
    expect(closed.badges).toEqual(['archived', 'matured']);
    expect(closed.canMoveMoney).toBe(false);
    expect(closed.canEditTerms).toBe(false);
  });
});
