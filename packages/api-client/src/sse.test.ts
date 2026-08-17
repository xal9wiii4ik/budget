// The SSE frame parser is the one genuinely test-worthy unit in the advisor
// scope (WS-7): every failure mode of a streamed answer — truncation, mojibake, a
// swallowed terminal event — lives in this ~60-line module, and none of them is
// reachable from a test that feeds one big well-formed chunk. Hence the byte-split
// arms below.
import { describe, expect, it } from 'vitest';

import { createSseFrameParser } from './sse';

const encoder = new TextEncoder();

/** Feed a whole payload as ONE chunk. */
function parseWhole(payload: string) {
  const parser = createSseFrameParser();
  const frames = parser.push(encoder.encode(payload));
  return [...frames, ...parser.flush()];
}

/** Feed a payload as BYTE chunks split at the given byte offsets. */
function parseSplitAt(payload: string, ...offsets: number[]) {
  const bytes = encoder.encode(payload);
  const parser = createSseFrameParser();
  const frames = [];
  let start = 0;
  for (const offset of [...offsets, bytes.length]) {
    frames.push(...parser.push(bytes.slice(start, offset)));
    start = offset;
  }
  return [...frames, ...parser.flush()];
}

describe('createSseFrameParser', () => {
  it('1: parses a whole frame delivered in one chunk', () => {
    expect(parseWhole('event: delta\ndata: {"text":"hi"}\n\n')).toEqual([
      { event: 'delta', data: '{"text":"hi"}' },
    ]);
  });

  it('2: reassembles the same frame across three different chunk boundaries', () => {
    const payload = 'event: delta\ndata: {"text":"hi"}\n\n';
    const expected = [{ event: 'delta', data: '{"text":"hi"}' }];

    // mid-field-name: "eve|nt: delta"
    expect(parseSplitAt(payload, 3)).toEqual(expected);
    // mid-data: '{"te|xt":"hi"}'
    expect(parseSplitAt(payload, payload.indexOf('xt":"hi"'))).toEqual(expected);
    // EXACTLY between the two terminating newlines — the split a naive
    // `chunk.split('\n\n')` gets wrong, because neither half contains "\n\n".
    expect(parseSplitAt(payload, payload.length - 1)).toEqual(expected);
  });

  it('3: reassembles a Cyrillic payload split mid-character, with no replacement chars', () => {
    // Every Cyrillic letter is TWO UTF-8 bytes, and the advisor answers in
    // Russian — so a split inside a character is a WHEN, not an IF. A
    // non-streaming decoder passes test 2 and fails this one; that contrast is
    // why both exist.
    const payload = 'event: delta\ndata: {"text":"Привет"}\n\n';
    const bytes = encoder.encode(payload);
    // Byte index of the second byte of "П" (the first Cyrillic char).
    const cyrillicStart = encoder.encode('event: delta\ndata: {"text":"').length;
    const frames = parseSplitAt(payload, cyrillicStart + 1);

    expect(frames).toEqual([{ event: 'delta', data: '{"text":"Привет"}' }]);
    expect(frames[0]?.data).not.toContain('�');
    // Guard on the fixture itself: the split really was inside a character.
    expect(bytes[cyrillicStart]).toBeGreaterThan(0x7f);
  });

  it('4: returns multiple frames from one chunk, in order', () => {
    expect(
      parseWhole('event: delta\ndata: {"text":"a"}\n\nevent: delta\ndata: {"text":"b"}\n\n'),
    ).toEqual([
      { event: 'delta', data: '{"text":"a"}' },
      { event: 'delta', data: '{"text":"b"}' },
    ]);
  });

  it('5: treats CRLF line endings identically (proxy normalization)', () => {
    expect(parseWhole('event: done\r\ndata: {}\r\n\r\n')).toEqual([
      { event: 'done', data: '{}' },
    ]);
    // …including when the CR and its LF land in different chunks.
    const payload = 'event: done\r\ndata: {}\r\n\r\n';
    expect(parseSplitAt(payload, payload.length - 1)).toEqual([{ event: 'done', data: '{}' }]);
  });

  it('6: ignores comments and unknown fields without losing the next real frame', () => {
    expect(
      parseWhole(': ping\n\nid: 7\nretry: 1000\nevent: delta\ndata: {"text":"hi"}\n\n'),
    ).toEqual([{ event: 'delta', data: '{"text":"hi"}' }]);
  });

  it('7: joins multiple data lines with a newline', () => {
    // A parser that drops the second data line silently truncates an answer.
    expect(parseWhole('event: delta\ndata: line one\ndata: line two\n\n')).toEqual([
      { event: 'delta', data: 'line one\nline two' },
    ]);
  });

  it('8: never dispatches a truncated trailing frame, on push or on flush', () => {
    const parser = createSseFrameParser();
    // One complete frame, then a frame cut off before its blank line.
    const pushed = parser.push(
      encoder.encode('event: delta\ndata: {"text":"hi"}\n\nevent: done\ndata: {}\n'),
    );
    expect(pushed).toEqual([{ event: 'delta', data: '{"text":"hi"}' }]);
    // This is the property that makes "the stream dropped before its terminal
    // event" detectable at all: flush() must NOT invent the missing `done`.
    expect(parser.flush()).toEqual([]);
  });
});
