// The pending OAuth consent request (mcp-remote W1): one read and one write,
// both addressed by the `?req=` id the authorization server put in the URL.
//
//   GET  /oauth/requests/{id}           -> who is asking, and where they go next
//   POST /oauth/requests/{id}/decision  -> {redirect_to}
//
// Invalidation matrix: EMPTY, deliberately. The read is single-use and cannot
// change under us (its only possible transition is into the 404 that the
// decision itself produces), and the decision creates no row this client caches
// — the grant appears at CODE EXCHANGE, inside Claude's token request
// (architecture D3). See the sentence in data/queryKeys.ts.
//
// No optimistic update: `redirect_to` is composed by the server from the
// redirect_uri it stored at /oauth/authorize, so there is nothing a client could
// predict.
import type { components } from '@budget/api-client';
import { useMutation, useQuery } from '@tanstack/react-query';

import { apiClient } from '../lib/api';
import { throwOnError } from '../lib/query';
import { qk } from './queryKeys';

export type OAuthRequestRead = components['schemas']['OAuthRequestRead'];
export type OAuthDecision = components['schemas']['OAuthDecision'];
export type OAuthDecisionResult = components['schemas']['OAuthDecisionResult'];

/**
 * The request the consent page is about. `staleTime: Infinity` because a refetch
 * could only ever answer 404 (the row is consumed by the decision), and a
 * background refetch that turns a live dialogue into an error arm mid-click is
 * precisely the failure mode to avoid.
 */
export function useOAuthRequest(requestId: string) {
  return useQuery<OAuthRequestRead>({
    queryKey: qk.oauthRequest(requestId),
    queryFn: () =>
      throwOnError(
        apiClient.GET('/oauth/requests/{request_id}', {
          params: { path: { request_id: requestId } },
        }),
      ),
    staleTime: Infinity,
  });
}

/**
 * Allow or deny. The answer is an address to send the browser to — the caller
 * navigates in the mutation's `onSuccess`, never in an effect: under StrictMode
 * an effect would fire twice and re-post a single-use decision.
 */
export function useOAuthDecision(requestId: string) {
  return useMutation<OAuthDecisionResult, unknown, OAuthDecision>({
    mutationFn: (body) =>
      throwOnError(
        apiClient.POST('/oauth/requests/{request_id}/decision', {
          params: { path: { request_id: requestId } },
          body,
        }),
      ),
  });
}
