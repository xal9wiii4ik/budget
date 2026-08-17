// Server-Sent Events frame parser — the 0.3 D2c escape hatch, part 1 of 2 (WS-7).
//
// PLATFORM NOTE, worded honestly (AM-2): this module references NO DOM globals
// (`window`, `document`, `localStorage`, `navigator`) — but it DOES use
// `TextDecoder`, which is a RUNTIME global, not a DOM API. It is available in
// browsers, Node >= 11 and (as of RN 0.74) Hermes; claiming blanket platform
// freedom would be a lie, so the dependency is named instead.
//
// The parser is deliberately transport-agnostic and holds no network state: it
// takes bytes in and gives whole frames out. That is what makes the one genuinely
// novel piece of the advisor testable at the byte level (sse.test.ts) instead of
// only through a live stream.
//
// Spec behaviours implemented (https://html.spec.whatwg.org/multipage/server-sent-events.html):
//   * lines terminate on "\n", "\r\n" or a lone "\r" (proxies rewrite these);
//   * a line starting with ":" is a comment (heartbeat) and is ignored;
//   * "field: value" strips EXACTLY ONE leading space from the value;
//   * a line with no colon is a field with an empty value;
//   * multiple `data:` lines in one frame are joined with "\n";
//   * a frame is dispatched ONLY on a blank line — an event with no data lines
//     dispatches nothing, and an unterminated trailing frame is discarded.
//
// That last rule is load-bearing twice over: it is what lets `askAdvisor` detect
// "the stream dropped before its terminal event" (a truncated frame is never
// mistaken for a complete one), and it is why `flush()` cannot invent a frame.

/** One dispatched SSE frame. `event` defaults to "message" when the field is absent. */
export interface SseFrame {
  event: string;
  data: string;
}

export interface SseFrameParser {
  /** Feed the next network chunk; returns every frame completed by it (in order). */
  push(chunk: Uint8Array): SseFrame[];
  /**
   * End of stream: flush the decoder and dispatch anything a final line
   * terminator completes. A trailing frame with no blank line is DISCARDED —
   * never dispatched (see the note above).
   */
  flush(): SseFrame[];
}

const DEFAULT_EVENT = 'message';

export function createSseFrameParser(): SseFrameParser {
  // The streaming decoder is the whole reason this owns a TextDecoder instead of
  // taking strings: a multi-byte character (every Cyrillic letter is two bytes)
  // split across two network chunks would otherwise decode to U+FFFD twice and
  // silently corrupt the answer. `{ stream: true }` holds the partial sequence
  // back until its remaining bytes arrive.
  const decoder = new TextDecoder('utf-8');

  // Undecoded-into-lines text. Holds at most one partial line (plus, briefly, a
  // trailing "\r" whose "\n" may still be in the next chunk).
  let buffer = '';

  // Fields of the frame currently being accumulated.
  let eventName = '';
  let dataLines: string[] = [];

  function resetFrame(): void {
    eventName = '';
    dataLines = [];
  }

  /**
   * Split `buffer` into complete lines, leaving the trailing partial line behind.
   * A "\r" at the very end is NOT treated as a terminator unless `final`, because
   * the matching "\n" may be the first byte of the next chunk.
   */
  function takeLines(final: boolean): string[] {
    const lines: string[] = [];
    let start = 0;
    let i = 0;
    while (i < buffer.length) {
      const char = buffer[i];
      if (char === '\n') {
        lines.push(buffer.slice(start, i));
        i += 1;
        start = i;
      } else if (char === '\r') {
        if (i === buffer.length - 1 && !final) break;
        lines.push(buffer.slice(start, i));
        i += buffer[i + 1] === '\n' ? 2 : 1;
        start = i;
      } else {
        i += 1;
      }
    }
    buffer = buffer.slice(start);
    return lines;
  }

  function consume(lines: string[]): SseFrame[] {
    const frames: SseFrame[] = [];
    for (const line of lines) {
      if (line === '') {
        // Blank line = dispatch. An event with no data lines dispatches nothing
        // (spec), but still clears the pending event name.
        if (dataLines.length > 0) {
          frames.push({ event: eventName === '' ? DEFAULT_EVENT : eventName, data: dataLines.join('\n') });
        }
        resetFrame();
        continue;
      }
      if (line.startsWith(':')) continue; // comment / heartbeat

      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);

      if (field === 'event') eventName = value;
      else if (field === 'data') dataLines.push(value);
      // `id`, `retry` and any unknown field are ignored: nothing in this protocol
      // reconnects, and a future field must not break an old client.
    }
    return frames;
  }

  return {
    push(chunk: Uint8Array): SseFrame[] {
      buffer += decoder.decode(chunk, { stream: true });
      return consume(takeLines(false));
    },
    flush(): SseFrame[] {
      buffer += decoder.decode();
      const frames = consume(takeLines(true));
      // Whatever is left is an unterminated line: discard it rather than guess.
      buffer = '';
      resetFrame();
      return frames;
    },
  };
}
