// The caps and the alternation rule are the whole reason this module is pure: a
// history that starts with an assistant turn, or that exceeds a server cap, comes
// back to the user as an opaque ANTHROPIC_ERROR / 422 they cannot act on.
import { describe, expect, it } from 'vitest';

import { buildHistory, HISTORY_MAX_TURNS, type TranscriptTurn } from './history';

function turn(
  index: number,
  role: TranscriptTurn['role'],
  text: string,
  status: TranscriptTurn['status'] = 'complete',
): TranscriptTurn {
  return { id: `${role}-${index}`, role, text, status };
}

/** `count` complete user/assistant pairs, each turn's text tagged with its index. */
function pairs(count: number, textFor: (index: number) => string = (i) => `t${i}`) {
  const turns: TranscriptTurn[] = [];
  for (let i = 0; i < count; i += 1) {
    turns.push(turn(i, 'user', `q${i} ${textFor(i)}`));
    turns.push(turn(i, 'assistant', `a${i} ${textFor(i)}`));
  }
  return turns;
}

describe('buildHistory', () => {
  it('14: trims 12 turns to 10 by dropping the OLDEST PAIR, keeping user-first alternation', () => {
    const history = buildHistory(pairs(6));

    expect(history).toHaveLength(HISTORY_MAX_TURNS);
    // The oldest PAIR went, not just the oldest turn — which is what keeps the
    // result starting with `user`.
    expect(history[0]).toEqual({ role: 'user', content: 'q1 t1' });
    expect(history[1]).toEqual({ role: 'assistant', content: 'a1 t1' });
    expect(history.map((t) => t.role)).toEqual(
      Array.from({ length: HISTORY_MAX_TURNS }, (_, i) => (i % 2 === 0 ? 'user' : 'assistant')),
    );
  });

  it('15: trims by total characters as well as by turn count', () => {
    // Two pairs, each ~5000 chars: under the 10-turn cap, over the 8000-char one.
    const long = buildHistory(pairs(2, () => 'x'.repeat(2500)));
    expect(long).toHaveLength(2);
    expect(long[0].role).toBe('user');
    expect(long[0].content).toContain('q1');
    expect(
      long.reduce((total, t) => total + t.content.length, 0),
    ).toBeLessThanOrEqual(8000);

    // Contrast, just under the cap: nothing is dropped.
    const short = buildHistory(pairs(2, () => 'x'.repeat(1900)));
    expect(short).toHaveLength(4);
    expect(short[0].content).toContain('q0');
  });

  it('16: excludes an unusable answer together with its user turn, and empty turns', () => {
    const history = buildHistory([
      turn(0, 'user', 'kept question'),
      turn(0, 'assistant', 'kept answer'),
      turn(1, 'user', 'stopped question'),
      turn(1, 'assistant', 'half an ans', 'stopped'),
      turn(2, 'user', 'failed question'),
      turn(2, 'assistant', 'nothing', 'error'),
      turn(3, 'user', 'streaming question'),
      turn(3, 'assistant', 'still going', 'streaming'),
      turn(4, 'user', '   '),
      turn(4, 'assistant', 'answer to a blank question'),
    ]);

    // Only the one complete pair survives — and crucially the DANGLING user turns
    // are gone too, so the payload still alternates from `user`.
    expect(history).toEqual([
      { role: 'user', content: 'kept question' },
      { role: 'assistant', content: 'kept answer' },
    ]);
  });
});
