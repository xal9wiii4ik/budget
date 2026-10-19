// Semantic transaction search (rag Web A) — `GET /transactions/search`.
//
// A QUERY, not a mutation: it is a read whose answer is a pure function of the
// phrase and the filters, it is shareable through the URL, and it must survive a
// remount without re-embedding the same sentence.
import type { components } from '@budget/api-client';
import { skipToken, useQuery } from '@tanstack/react-query';

import { apiClient } from '../lib/api';
import { throwOnError } from '../lib/query';
import { qk, type TxSearchParams } from './queryKeys';

// The contract's own shapes since the S2 regen — the `data/imports.ts`
// convention, and the end of the part-A1 shim (`data/ragContract.ts` is gone):
// nothing in this scope redeclares a server type any more.
//
// The three live HERE, in the module that owns the search read, and the advisor
// surface imports two of them from here on purpose: ASK-2 CONFIRMED that a
// citation is literally a `TransactionSearchHit` and that the Q&A's `total` is
// literally a `SearchTotal`, so one web component renders each (QaCitation,
// SearchTotals) off one type rather than off two that happen to agree today.
export type TransactionSearchRead = components['schemas']['TransactionSearchRead'];
export type TransactionSearchHit = components['schemas']['TransactionSearchHit'];
export type SearchTotal = components['schemas']['SearchTotal'];

// The request/key slice is declared beside the other key slices
// (`TxListFilters`, `FxConvertParams`) and re-exported here, the `data/fx.ts`
// precedent: a consumer of the hook gets the type from the hook's module, while
// the key grammar stays in one file.
export type { TxSearchParams };

/**
 * How long one answer stays fresh. Five minutes, not the global 30 s: the result
 * set moves only through transaction WRITES, and every one of those already
 * invalidates this key (the `key[1] !== 'summary'` predicate covers
 * `['transactions','search', …]`). Without it, walking away from the tab and
 * back would spend another embedding call and another of the 30/min tokens on a
 * question whose answer cannot have changed.
 */
const SEARCH_STALE_MS = 5 * 60_000;

/**
 * One semantic search. `null` params = nothing committed yet, which disables the
 * query under a stable key rather than firing a blank `q` the server answers
 * with 422 `SEARCH_QUERY_BLANK`.
 *
 * `skipToken` IS that disabled state (the `data/fx.ts` precedent, same state as
 * `enabled: false`): it also types the request function without a non-null
 * assertion, since the params are captured as a narrowed const rather than
 * re-narrowed inside the closure.
 *
 * `retry: false` overrides the global policy (transient failures ×2) ON PURPOSE:
 * every attempt is a model call plus one of the user's 30 searches a minute, and
 * the failure that matters here — 503 `EMBEDDINGS_NOT_AVAILABLE`, a missing
 * artifact — is deterministic, so a retry can only turn one honest "unavailable"
 * into three. The screen offers a Retry BUTTON instead; a retry the user asked
 * for is a different thing from one the library guessed at.
 */
export function useTxSearch(params: TxSearchParams | null) {
  const request = params;
  return useQuery({
    queryKey: qk.txSearch(request),
    queryFn:
      request === null
        ? skipToken
        : () =>
            throwOnError(
              apiClient.GET('/transactions/search', { params: { query: request } }),
            ),
    staleTime: SEARCH_STALE_MS,
    retry: false,
  });
}
