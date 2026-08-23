import type { components } from '@budget/api-client';
import { describe, expect, it } from 'vitest';

import { selectableAccounts } from './accountOptions';

type AccountRead = components['schemas']['AccountRead'];

function account(overrides: Partial<AccountRead> = {}): AccountRead {
  return {
    id: 'acc-live',
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

describe('selectableAccounts', () => {
  it('keeps the form’s STARTING account selectable when it is archived', () => {
    // Load-bearing for the "+" shortcut (recurring-book-now R5): a template on an
    // archived account prefills that account, and the <select> must be able to
    // show it. Drop it from the options and the control silently falls back to
    // another account — the save then succeeds against the WRONG one instead of
    // failing with the honest 422 ACCOUNT_ARCHIVED.
    const live = account();
    const archived = account({ id: 'acc-old', name: 'Old card', archived: true });
    const otherArchived = account({ id: 'acc-other', name: 'Other', archived: true });
    const accounts = [live, archived, otherArchived];

    expect(selectableAccounts(accounts, 'acc-old')).toEqual([live, archived]);
    // Nothing else archived leaks in, and no account is listed twice.
    expect(selectableAccounts(accounts, null)).toEqual([live]);
  });
});
