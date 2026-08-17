// What of the on-screen transcript actually travels back to the server (WS-8).
//
// PURE by design: no React, no fetch, no clock. The caps are enforced HERE, before
// the send, so the user never sees a raw 422 for a conversation that simply grew.
// They mirror `schemas/advisor.py` exactly: <=10 turns, <=8000 characters summed
// over the history (the question is capped separately by `advisorAskSchema`).
import type { AdvisorTurn } from '@budget/api-client';

/** A turn as it exists on screen. `status` is what the renderer switches on. */
export interface TranscriptTurn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  status: 'complete' | 'streaming' | 'stopped' | 'error';
}

export const HISTORY_MAX_TURNS = 10;
export const HISTORY_MAX_CHARS = 8000;

/**
 * Build the `history` payload from the transcript.
 *
 * Four guarantees, all load-bearing:
 *
 * 1. At most 10 turns and 8000 total content characters (the server's caps).
 * 2. Trimming drops the OLDEST COMPLETE PAIR, never a single turn. The router
 *    builds `[*history, question]` for the Anthropic SDK, which requires strict
 *    alternation starting with `user`; a history beginning with an assistant turn
 *    would surface to the user as a mysterious ANTHROPIC_ERROR.
 * 3. The result therefore always starts with `user` and alternates.
 * 4. An aborted (`stopped`), failed (`error`) or still-streaming assistant answer
 *    is excluded TOGETHER WITH ITS USER TURN — an incomplete answer is not context
 *    the model should reason from, and dropping only one half would break the
 *    alternation. Such a turn stays visible on screen; it just does not travel.
 *    Empty/whitespace-only content is excluded the same way (`content` has
 *    min_length=1 server-side).
 */
export function buildHistory(turns: TranscriptTurn[]): AdvisorTurn[] {
  // Pair each user turn with the assistant answer that follows it, keeping only
  // pairs where BOTH halves are usable.
  const pairs: [AdvisorTurn, AdvisorTurn][] = [];
  for (let i = 0; i < turns.length; i += 1) {
    const question = turns[i];
    const answer = turns[i + 1];
    if (question === undefined || question.role !== 'user') continue;
    if (answer === undefined || answer.role !== 'assistant') continue;
    i += 1; // the answer is consumed by this pair either way

    if (answer.status !== 'complete') continue;
    const questionText = question.text.trim();
    const answerText = answer.text.trim();
    if (questionText === '' || answerText === '') continue;

    pairs.push([
      { role: 'user', content: questionText },
      { role: 'assistant', content: answerText },
    ]);
  }

  // Drop from the front until both caps hold. A single pair that is over the cap
  // on its own is dropped too, leaving an empty history — a truthful "no context"
  // beats a 422 the user cannot act on.
  let chars = pairs.reduce(
    (total, [question, answer]) => total + question.content.length + answer.content.length,
    0,
  );
  let start = 0;
  while (
    start < pairs.length &&
    ((pairs.length - start) * 2 > HISTORY_MAX_TURNS || chars > HISTORY_MAX_CHARS)
  ) {
    const [question, answer] = pairs[start];
    chars -= question.content.length + answer.content.length;
    start += 1;
  }

  return pairs.slice(start).flat();
}
