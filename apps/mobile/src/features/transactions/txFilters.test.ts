import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TX_SORT,
  TX_LIST_LIMIT,
  categoryListFilters,
  toTxSort,
  txListFilters,
  type TxSelection,
} from './txFilters';

// The unfiltered month, as the screen holds it.
function selection(overrides: Partial<TxSelection> = {}): TxSelection {
  return {
    mode: { kind: 'month', month: '2026-08' },
    accountId: null,
    categoryId: null,
    q: null,
    country: null,
    sort: null,
    ...overrides,
  };
}

// The ONE thing in this module that breaks silently: the CACHE KEY. Everything
// else here is either exercised by the screen the moment it renders (a missing
// chip is visible) or copied from a web module that is tested there. A key that
// grows an `undefined`-valued member, or a second spelling of the default order,
// costs a duplicate request and a stale list — and neither shows up on screen.
describe('txListFilters — the omission rule', () => {
  it('gives the unfiltered month exactly the three-member key it has always had', () => {
    const filters = txListFilters(selection(), TX_LIST_LIMIT);

    // Not `toEqual` on the members: `toEqual` treats `{ q: undefined }` as equal to
    // `{}`, and an `undefined`-valued member is precisely the failure — TanStack
    // Query hashes it as a DIFFERENT key from the one the shipped month list and the
    // transaction form's edit-row lookup use.
    expect(Object.keys(filters).sort()).toEqual(['from', 'limit', 'to']);
    expect(filters).toEqual({ from: '2026-08-01', to: '2026-08-31', limit: TX_LIST_LIMIT });
  });

  it('drops the window entirely in all-time mode', () => {
    const filters = txListFilters(selection({ mode: { kind: 'all' } }), TX_LIST_LIMIT);

    expect(Object.keys(filters).sort()).toEqual(['limit']);
  });

  it('adds only the members that are actually set', () => {
    const filters = txListFilters(
      selection({ q: 'coffee', country: 'GE', sort: 'amount_desc' }),
      TX_LIST_LIMIT,
    );

    expect(Object.keys(filters).sort()).toEqual([
      'country',
      'from',
      'limit',
      'q',
      'sort',
      'to',
    ]);
  });

  it("builds the category screen's key out of the tab's own grammar", () => {
    // The two must be byte-identical or the drill-down refetches rows the tab
    // already holds — and then the two screens can disagree about them.
    expect(categoryListFilters('cat-1', { kind: 'month', month: '2026-08' }, TX_LIST_LIMIT))
      .toEqual(txListFilters(selection({ categoryId: 'cat-1' }), TX_LIST_LIMIT));
  });
});

describe('toTxSort — the default order is never sent', () => {
  it('normalizes the server default to null', () => {
    // Picking "Newest first" back must return to the untouched list's key, not mint
    // a second cache entry describing the very same rows in the very same order.
    expect(toTxSort(DEFAULT_TX_SORT)).toBeNull();
    expect(txListFilters(selection({ sort: null }), TX_LIST_LIMIT).sort).toBeUndefined();
  });

  it('keeps a real non-default order and rejects anything else', () => {
    expect(toTxSort('amount_asc')).toBe('amount_asc');
    expect(toTxSort('date_sideways')).toBeNull();
    expect(toTxSort(null)).toBeNull();
  });
});
