// Cited question-and-answer over the user's operations (rag Web A) —
// `POST /advisor/qa`.
//
// NO QUERY KEY, NO CACHE ENTRY, NO INVALIDATION — the `data/advisor.ts` reasoning
// applies verbatim, and the three are separate statements:
//   * no query key, because the server is stateless and no GET could ever re-fill
//     such an entry (v1 keeps no history at all — D-Q2);
//   * no cache, because an answer is a one-shot side effect, not shared server
//     state — `useMutation.data` IS the last answer, read during render;
//   * no invalidation, because asking a question changes nothing server-side.
//
// It must also NOT be a query for a reason the chat does not have: a query would
// retry, and a retry here is a second LLM bill for a question nobody asked
// twice. Mutations carry no retry by default — that default is the guard, so
// nothing in this file turns it on.
import type { components } from '@budget/api-client';
import { useMutation } from '@tanstack/react-query';

import { apiClient } from '../lib/api';
import { throwOnError } from '../lib/query';

// The contract's own shapes since the S2 regen (`data/imports.ts` convention);
// the part-A1 shim is deleted.
export type AdvisorQaAsk = components['schemas']['AdvisorQaAsk'];
export type AdvisorQaRead = components['schemas']['AdvisorQaRead'];

/**
 * How many operations the answer is grounded in — the SERVER's own default (the
 * body declares `limit` 1..50, default 20), written down in exactly one place.
 *
 * It is sent EXPLICITLY, which part A1 did not plan to do: the schema gives
 * `limit` a default, and the generated body type therefore makes it REQUIRED
 * (`limit: number`), so "omit it and take the server's 20" is not expressible
 * through the typed client. Sending the same 20 is the honest resolution — the
 * wire semantics are identical and the figure is a named constant instead of a
 * number repeated at a call site. v1 offers no control for it (`rag-qa-filters`).
 */
export const QA_RETRIEVAL_LIMIT = 20;

export function useAskQa() {
  return useMutation({
    mutationFn: (body: AdvisorQaAsk) =>
      throwOnError(apiClient.POST('/advisor/qa', { body })),
  });
}
