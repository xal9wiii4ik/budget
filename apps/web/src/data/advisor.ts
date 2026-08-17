// Advisor data layer (4.4 W3, WS-8).
//
// NO QUERY KEY, NO CACHE ENTRY, NO INVALIDATION — deliberately, and the three are
// separate statements:
//   * no query key, because the server is stateless (chat memory is client-carried)
//     and there is no GET that could ever re-fill such an entry;
//   * no cache, because an answer is a one-shot side effect, not shared server
//     state — parking it in the Query cache would be cache abuse;
//   * no invalidation, because asking a question changes nothing on the server.
// The transcript itself is transient client state and lives in useAdvisorChat's
// reducer (not Zustand — one screen, one session).
//
// A streaming POST is still a MUTATION by every definition, so pending/error come
// from the standard TanStack machinery; the deltas are handed to the caller
// through an `onEvent` callback in the mutation variables, which is what lets the
// reducer append text without any of it touching the cache.
import { askAdvisor, type AdvisorAsk, type AdvisorStreamEvent } from '@budget/api-client';
import { useMutation } from '@tanstack/react-query';

import { baseUrl, coordinator } from '../lib/api';

export interface AskAdvisorVariables {
  body: AdvisorAsk;
  signal: AbortSignal;
  onEvent: (event: AdvisorStreamEvent) => void;
}

export function useAskAdvisor() {
  return useMutation({
    mutationFn: async ({ body, signal, onEvent }: AskAdvisorVariables) => {
      // `coordinator.authFetch` is the SAME injected seam the generated client
      // uses (lib/api.ts): one bearer source, one silent 401->refresh->retry, no
      // token read anywhere in this file or in askAdvisor.
      for await (const event of askAdvisor({
        baseUrl,
        fetch: coordinator.authFetch,
        body,
        signal,
      })) {
        onEvent(event);
      }
    },
  });
}
