import { describe, expect, it } from 'vitest';

import {
  parseTxFilters,
  txListFilters,
  TX_LIST_LIMIT,
} from '../transactions/txFilters';
import { txWindowHref } from '../transactions/txWindow';
import { qaCitationHref } from './qaCitationHref';

const ACCOUNT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CITED = { account_id: ACCOUNT, occurred_at: '2026-09-14' };

describe('qaCitationHref', () => {
  it('links to the cited operation’s account, windowed to its own day', () => {
    expect(qaCitationHref(CITED)).toBe(
      `/transactions?account=${ACCOUNT}&from=2026-09-14&to=2026-09-14`,
    );
  });

  it('is the shared window grammar, not a second spelling of it', () => {
    // If this ever stops holding, the citation has invented a URL the
    // /transactions parser was never pinned against.
    expect(qaCitationHref(CITED)).toBe(
      txWindowHref(
        { kind: 'account', accountId: ACCOUNT },
        { kind: 'custom', from: '2026-09-14', to: '2026-09-14' },
      ),
    );
  });

  it('lands on a list that CONTAINS the cited row', () => {
    // The failure this guards against is a link that resolves to a list without
    // the row in it — which looks exactly like a citation the app made up. The
    // check is the txWindow.test.ts idiom: parse the href back the way the page
    // does and read the slice it would request.
    const href = qaCitationHref(CITED);
    const filters = txListFilters(
      parseTxFilters(new URLSearchParams(href.split('?')[1]), '2026-01'),
      TX_LIST_LIMIT,
    );
    expect(filters.account_id).toBe(ACCOUNT);
    // The server's window is inclusive on both ends, so asking for [d, d] of the
    // row's own account is the smallest slice that still holds the row.
    expect([filters.from, filters.to]).toEqual([CITED.occurred_at, CITED.occurred_at]);
  });
});
