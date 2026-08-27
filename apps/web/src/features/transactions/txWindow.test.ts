import { describe, expect, it } from 'vitest';

import { parseTxFilters, txListFilters, TX_LIST_LIMIT } from './txFilters';
import {
  txWindowFilters,
  txWindowHref,
  type TxWindowFilter,
  type TxWindowPeriod,
} from './txWindow';

const FOOD = '11111111-1111-4111-8111-111111111111';
const DEPOSIT_LEDGER = '33333333-3333-4333-8333-333333333333';

const MONTH: TxWindowPeriod = { kind: 'month', month: '2026-08' };
const CUSTOM: TxWindowPeriod = { kind: 'custom', from: '2026-08-01', to: '2026-08-15' };

describe('txWindowHref', () => {
  it('writes the parameters parseTxFilters reads, per filter and per period mode', () => {
    expect(txWindowHref({ kind: 'category', categoryId: FOOD }, MONTH)).toBe(
      `/transactions?category=${FOOD}&month=2026-08`,
    );
    expect(txWindowHref({ kind: 'category', categoryId: FOOD }, CUSTOM)).toBe(
      `/transactions?category=${FOOD}&from=2026-08-01&to=2026-08-15`,
    );
    expect(txWindowHref({ kind: 'account', accountId: DEPOSIT_LEDGER }, MONTH)).toBe(
      `/transactions?account=${DEPOSIT_LEDGER}&month=2026-08`,
    );
    expect(txWindowHref({ kind: 'account', accountId: DEPOSIT_LEDGER }, CUSTOM)).toBe(
      `/transactions?account=${DEPOSIT_LEDGER}&from=2026-08-01&to=2026-08-15`,
    );
  });
});

describe('txWindowFilters', () => {
  // THE cache-sharing invariant: a modal and the /transactions screen it links to
  // must ask for the SAME slice, or the same rows are fetched twice into two
  // entries. Rather than restating the expected object (which would pass while
  // both sides drifted together in the wrong direction), each case is compared
  // against what the PAGE builds after parsing this very href.
  const pageFilters = (href: string) =>
    txListFilters(
      parseTxFilters(new URLSearchParams(href.split('?')[1]), '2026-01'),
      TX_LIST_LIMIT,
    );

  const cases: Array<[string, TxWindowFilter, TxWindowPeriod]> = [
    ['category, month', { kind: 'category', categoryId: FOOD }, MONTH],
    ['category, custom period', { kind: 'category', categoryId: FOOD }, CUSTOM],
    ['account, month', { kind: 'account', accountId: DEPOSIT_LEDGER }, MONTH],
    ['account, custom period', { kind: 'account', accountId: DEPOSIT_LEDGER }, CUSTOM],
  ];

  for (const [name, filter, period] of cases) {
    it(`is the slice /transactions builds from the same link (${name})`, () => {
      expect(txWindowFilters(filter, period)).toStrictEqual(
        pageFilters(txWindowHref(filter, period)),
      );
    });
  }
});
