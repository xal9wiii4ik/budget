// askAdvisor against a fake `fetch` returning a real ReadableStream of bytes — no
// network, no MSW. The unit under test is the FAILURE TAXONOMY (WS-7): which of
// the four outcomes (terminal done, mid-stream error frame, silent drop,
// intentional abort) the caller is told about, and how.
import { describe, expect, it } from 'vitest';

import { askAdvisor, type AdvisorStreamEvent } from './advisor';
import { ApiError } from './errors';

const encoder = new TextEncoder();
const BASE_URL = 'https://api.test';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function okFetch(chunks: string[]) {
  return () =>
    Promise.resolve(
      new Response(streamOf(chunks), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
}

async function collect(stream: AsyncGenerator<AdvisorStreamEvent>) {
  const events: AdvisorStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const ASK = { question: 'куда уходят деньги?' };

describe('askAdvisor', () => {
  it('9: yields the deltas then done, and the text concatenates to the answer', async () => {
    const fetchFake = okFetch([
      'event: delta\ndata: {"text":"Вы "}\n\n',
      'event: delta\ndata: {"text":"тратите"}\n\n',
      'event: done\ndata: {}\n\n',
    ]);

    const events = await collect(askAdvisor({ baseUrl: BASE_URL, fetch: fetchFake, body: ASK }));

    expect(events).toEqual([
      { type: 'delta', text: 'Вы ' },
      { type: 'delta', text: 'тратите' },
      { type: 'done' },
    ]);
    const answer = events
      .filter((event): event is { type: 'delta'; text: string } => event.type === 'delta')
      .map((event) => event.text)
      .join('');
    expect(answer).toBe('Вы тратите');
  });

  it('10: throws ApiError with the parsed body BEFORE touching the stream (503, and a 429 contrast)', async () => {
    // The pre-stream channel: a non-2xx has no SSE frames to read, so the body
    // must be taken as text/JSON and never as a stream — otherwise a 503 would
    // surface as an empty answer instead of "AI недоступен".
    function errorFetch(status: number, body: string) {
      const response = new Response(body, {
        status,
        headers: { 'content-type': 'application/json' },
      });
      let bodyAccessed = false;
      // Shadow the `body` getter so any attempt to stream the error response is
      // observable (and yields nothing, which the event assertion then catches).
      Object.defineProperty(response, 'body', {
        get() {
          bodyAccessed = true;
          return null;
        },
      });
      return { fetch: () => Promise.resolve(response), wasStreamed: () => bodyAccessed };
    }

    const unconfigured = errorFetch(503, '{"detail":"AI_NOT_CONFIGURED"}');
    const events: AdvisorStreamEvent[] = [];
    let thrown: unknown;
    try {
      for await (const event of askAdvisor({
        baseUrl: BASE_URL,
        fetch: unconfigured.fetch,
        body: ASK,
      })) {
        events.push(event);
      }
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).status).toBe(503);
    expect((thrown as ApiError).body).toEqual({ detail: 'AI_NOT_CONFIGURED' });
    expect(events).toEqual([]);
    expect(unconfigured.wasStreamed()).toBe(false);

    // Contrast: the 429 arm carries its own status and code through the same path.
    const limited = errorFetch(429, '{"detail":"RATE_LIMITED"}');
    await expect(
      collect(askAdvisor({ baseUrl: BASE_URL, fetch: limited.fetch, body: ASK })),
    ).rejects.toMatchObject({ status: 429, body: { detail: 'RATE_LIMITED' } });
  });

  it('11: yields the deltas, then the mid-stream error frame, and nothing after it', async () => {
    const fetchFake = okFetch([
      'event: delta\ndata: {"text":"a"}\n\n',
      'event: delta\ndata: {"text":"b"}\n\n',
      'event: error\ndata: {"detail":"ANTHROPIC_ERROR"}\n\n',
      // Exactly one terminal frame is emitted (D9). A frame after it is a
      // protocol violation and must not reach the caller as a "done".
      'event: done\ndata: {}\n\n',
    ]);

    expect(await collect(askAdvisor({ baseUrl: BASE_URL, fetch: fetchFake, body: ASK }))).toEqual([
      { type: 'delta', text: 'a' },
      { type: 'delta', text: 'b' },
      { type: 'error', detail: 'ANTHROPIC_ERROR' },
    ]);
  });

  it('12: reports STREAM_INCOMPLETE when the stream ends with no terminal frame', async () => {
    // The D9 client obligation: a dropped connection must not present a truncated
    // answer as a finished one.
    const fetchFake = okFetch([
      'event: delta\ndata: {"text":"a"}\n\n',
      // …and a half-written frame, which must not be dispatched either.
      'event: delta\ndata: {"text":"b"',
    ]);

    expect(await collect(askAdvisor({ baseUrl: BASE_URL, fetch: fetchFake, body: ASK }))).toEqual([
      { type: 'delta', text: 'a' },
      { type: 'error', detail: 'STREAM_INCOMPLETE' },
    ]);
  });

  it('13: completes with NO terminal error when the caller aborts mid-stream', async () => {
    // An intentional stop is not a failure — the UI's `stopped` turn state (partial
    // answer kept, no error notice) depends on this distinction.
    let releaseHang: (() => void) | undefined;
    const hangingStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: delta\ndata: {"text":"a"}\n\n'));
      },
      pull() {
        // Never resolves: the server is still thinking when the user hits Stop.
        return new Promise<void>((resolve) => {
          releaseHang = resolve;
        });
      },
      cancel() {
        releaseHang?.();
      },
    });

    const abort = new AbortController();
    const events: AdvisorStreamEvent[] = [];
    for await (const event of askAdvisor({
      baseUrl: BASE_URL,
      fetch: () => Promise.resolve(new Response(hangingStream, { status: 200 })),
      body: ASK,
      signal: abort.signal,
    })) {
      events.push(event);
      abort.abort();
    }

    expect(events).toEqual([{ type: 'delta', text: 'a' }]);
  });
});
