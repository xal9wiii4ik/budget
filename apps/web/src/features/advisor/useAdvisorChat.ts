// The advisor conversation: transient, single-screen client state (WS-8).
//
// NOT Zustand (zustand is not a dependency of apps/web and this scope does not add
// one) and NOT the Query cache: the server is stateless — chat memory is
// client-carried — so there is no GET to revalidate and no key that could ever be
// re-filled. A `useReducer` transcript plus an AbortController is the whole model;
// the network call itself is the mutation in data/advisor.ts.
//
// The reducer holds ONLY what cannot be derived: the turns. "Is something
// streaming", "was the last answer finished" and the send-button state are all
// derived during render (here or in the component), never mirrored by an effect.
import { useCallback, useEffect, useReducer, useRef } from 'react';

import { useAskAdvisor } from '../../data/advisor';
import { describeAdvisorError, type AdvisorFailure } from '../../lib/errors';
import { buildHistory, type TranscriptTurn } from './history';

/**
 * A transcript turn. `status` is a discriminating field the renderer switches on:
 *   streaming — text is still arriving (assistant only)
 *   complete  — the answer finished normally
 *   stopped   — the user pressed Stop; the partial text STAYS on screen
 *   error     — the ask failed; `failure` carries what to say about it
 *
 * `failure` is the plan's `errorDetail` slot, resolved through the WS-6 table at
 * dispatch time so the component holds no copy and no error taxonomy: it also
 * carries whether the partial text above it is real (`keepsPartialAnswer`), which
 * a bare code string could not express for the network arm.
 */
export interface ChatTurn extends TranscriptTurn {
  failure?: AdvisorFailure;
}

interface ChatState {
  turns: ChatTurn[];
}

type Action =
  | { type: 'ask'; question: ChatTurn; answer: ChatTurn }
  | { type: 'delta'; id: string; text: string }
  | { type: 'done'; id: string }
  | { type: 'failed'; id: string; failure: AdvisorFailure }
  | { type: 'stop'; id: string }
  // Safety net on settle: a turn must never be left spinning if the stream ends
  // in a way no branch above covered.
  | { type: 'settle'; id: string };

function patchTurn(state: ChatState, id: string, patch: (turn: ChatTurn) => ChatTurn): ChatState {
  return { turns: state.turns.map((turn) => (turn.id === id ? patch(turn) : turn)) };
}

function reduce(state: ChatState, action: Action): ChatState {
  switch (action.type) {
    case 'ask':
      return { turns: [...state.turns, action.question, action.answer] };
    case 'delta':
      return patchTurn(state, action.id, (turn) => ({ ...turn, text: turn.text + action.text }));
    case 'done':
      return patchTurn(state, action.id, (turn) => ({ ...turn, status: 'complete' }));
    case 'failed':
      return patchTurn(state, action.id, (turn) => ({
        ...turn,
        status: 'error',
        failure: action.failure,
      }));
    case 'stop':
      return patchTurn(state, action.id, (turn) =>
        turn.status === 'streaming' ? { ...turn, status: 'stopped' } : turn,
      );
    case 'settle':
      return patchTurn(state, action.id, (turn) =>
        turn.status === 'streaming' ? { ...turn, status: 'stopped' } : turn,
      );
  }
}

export interface AdvisorChat {
  turns: ChatTurn[];
  /** True while an answer is arriving — drives Stop/Ask enablement. */
  isStreaming: boolean;
  /**
   * Send a question. Returns FALSE when it was refused because an answer is
   * still streaming — the composer keys its "clear the input" on this, so a
   * refused send can never silently swallow what the user typed.
   */
  ask: (question: string) => boolean;
  stop: () => void;
}

export function useAdvisorChat(): AdvisorChat {
  const [state, dispatch] = useReducer(reduce, { turns: [] });
  const abortRef = useRef<AbortController | null>(null);
  const idRef = useRef(0);
  const { mutate } = useAskAdvisor();

  // Real external effect: tear the connection down if the screen goes away
  // mid-answer. Nothing is synced here.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  const turns = state.turns;
  const isStreaming = turns[turns.length - 1]?.status === 'streaming';

  const ask = useCallback(
    (question: string): boolean => {
      // One answer at a time: the composer is disabled while streaming, and this
      // guard makes a double-submit structurally impossible.
      if (abortRef.current !== null) return false;

      idRef.current += 1;
      const questionTurn: ChatTurn = {
        id: `u${idRef.current}`,
        role: 'user',
        text: question,
        status: 'complete',
      };
      const answerTurn: ChatTurn = {
        id: `a${idRef.current}`,
        role: 'assistant',
        text: '',
        status: 'streaming',
      };
      // Built from the transcript BEFORE this question is appended — the question
      // travels in its own field, never twice.
      const history = buildHistory(turns);

      const controller = new AbortController();
      abortRef.current = controller;
      dispatch({ type: 'ask', question: questionTurn, answer: answerTurn });

      mutate(
        {
          body: { question, history },
          signal: controller.signal,
          onEvent: (event) => {
            switch (event.type) {
              case 'delta':
                dispatch({ type: 'delta', id: answerTurn.id, text: event.text });
                break;
              case 'done':
                dispatch({ type: 'done', id: answerTurn.id });
                break;
              case 'error':
                // Mid-stream: a bare detail string, because the 200 was sent long
                // before the failure (WS-7). Whatever text arrived stays.
                dispatch({
                  type: 'failed',
                  id: answerTurn.id,
                  failure: describeAdvisorError(event.detail),
                });
                break;
            }
          },
        },
        {
          // Pre-stream failures (503 / 429 / network) arrive here as a thrown
          // ApiError — the same table maps them.
          onError: (error) => {
            dispatch({ type: 'failed', id: answerTurn.id, failure: describeAdvisorError(error) });
          },
          onSettled: () => {
            abortRef.current = null;
            dispatch({ type: 'settle', id: answerTurn.id });
          },
        },
      );
      return true;
    },
    [mutate, turns],
  );

  const stop = useCallback(() => {
    const controller = abortRef.current;
    if (controller === null) return;
    controller.abort();
    // An intentional stop is not a failure (askAdvisor completes with no terminal
    // error), so the turn is marked `stopped` here and keeps its partial text.
    const streaming = turns[turns.length - 1];
    if (streaming !== undefined && streaming.status === 'streaming') {
      dispatch({ type: 'stop', id: streaming.id });
    }
  }, [turns]);

  return { turns, isStreaming, ask, stop };
}
