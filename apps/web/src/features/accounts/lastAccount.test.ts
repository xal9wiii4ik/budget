import { describe, expect, it } from 'vitest';

import type { AccountRead } from '../../data/accounts';
import { pickDefaultAccount } from './lastAccount';

function account(overrides: Partial<AccountRead> & { id: string }): AccountRead {
  return {
    name: overrides.id,
    type: 'card',
    currency: 'USD',
    starting_balance_minor: 0,
    balance_minor: 0,
    archived: false,
    created_at: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

const usd = account({ id: 'acc-usd' });
const byn = account({ id: 'acc-byn', currency: 'BYN' });
const old = account({ id: 'acc-old', archived: true });

describe('pickDefaultAccount', () => {
  it('uses the remembered account when it is still usable', () => {
    expect(pickDefaultAccount([usd, byn], 'acc-byn')).toBe('acc-byn');
  });

  it('does NOT preselect a remembered account that has been archived', () => {
    // The server refuses a write to an archived account (ACCOUNT_ARCHIVED), so
    // preselecting it would open every form on a guaranteed 422.
    expect(pickDefaultAccount([usd, byn, old], 'acc-old')).toBe('');
  });

  it('falls back to the single usable account, but never guesses among several', () => {
    expect(pickDefaultAccount([usd, old], 'acc-gone')).toBe('acc-usd');
    // Two candidates: picking one would silently put money on the wrong account.
    expect(pickDefaultAccount([usd, byn], 'acc-gone')).toBe('');
  });

  it('returns nothing with no accounts, or with nothing remembered and several to choose from', () => {
    expect(pickDefaultAccount([], null)).toBe('');
    expect(pickDefaultAccount([usd, byn], null)).toBe('');
    expect(pickDefaultAccount([usd], null)).toBe('acc-usd');
  });
});
