import { describe, expect, it } from 'vitest';

import type { AccountRead } from '../../data/accounts';
import type { DepositRead } from '../../data/deposits';
import { depositAccountEntries, mergedAccountIndex } from './depositAccounts';

function account(overrides: Partial<AccountRead> = {}): AccountRead {
  return {
    id: 'acc-1',
    name: 'Card',
    type: 'card',
    currency: 'USD',
    starting_balance_minor: 0,
    balance_minor: 0,
    archived: false,
    created_at: '2026-08-01T10:00:00Z',
    ...overrides,
  };
}

function deposit(overrides: Partial<DepositRead> = {}): DepositRead {
  return {
    id: 'dep-1',
    name: 'Bank deposit',
    account_id: 'acc-deposit-1',
    currency: 'BYN',
    rate_percent: '10.95',
    capitalization: 'monthly',
    opened_on: '2025-08-01',
    term_end: '2026-08-01',
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

describe('depositAccountEntries', () => {
  it('keys a deposit by its LEDGER account, not by its own id', () => {
    // The whole point of the index: what a transfer row points at is
    // `account_id`. Keying by `deposit.id` would build a map that resolves
    // nothing and silently leaves every top-up row name-less.
    const [entry] = depositAccountEntries([deposit({ id: 'dep-1', account_id: 'acc-9' })]);

    expect(entry.id).toBe('acc-9');
    expect(entry.kind).toBe('deposit');
  });

  it("takes the archived flag from the DEPOSIT, so a closed one is not shown as live", () => {
    const [entry] = depositAccountEntries([deposit({ archived: true })]);

    expect(entry.archived).toBe(true);
  });
});

describe('mergedAccountIndex', () => {
  it('resolves both an ordinary account and a deposit ledger', () => {
    const index = mergedAccountIndex(
      [account({ id: 'acc-1', name: 'Card', currency: 'USD' })],
      [deposit({ account_id: 'acc-deposit-1', name: 'Bank deposit', currency: 'BYN' })],
    );

    expect(index.get('acc-1')).toMatchObject({ name: 'Card', currency: 'USD', kind: 'account' });
    expect(index.get('acc-deposit-1')).toMatchObject({
      name: 'Bank deposit',
      // The currency has to come through: it is the EXPONENT the transfer form's
      // schema parses that leg's amount with.
      currency: 'BYN',
      kind: 'deposit',
    });
  });
});
