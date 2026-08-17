// The advisor streaming client — the 0.3 D2c escape hatch, part 2 of 2 (WS-7).
//
// WHY THIS IS HAND-WRITTEN AND NOT GENERATED: `POST /advisor/ask` answers with
// `text/event-stream`. openapi-fetch parses a whole body (json/text/blob) and has
// no streaming mode, and the browser's `EventSource` is GET-only — the endpoint is
// a POST carrying a JSON body, so EventSource is structurally unusable. A hand
// written fetch + ReadableStream reader is the only option. This file imports
// TYPES ONLY from `./generated/schema` and hand-edits nothing generated; the path
// string is `satisfies keyof paths`, so a contract rename fails typecheck here.
//
// PLATFORM NOTE, worded honestly (AM-2): no DOM globals (`window`, `document`,
// `localStorage`, `navigator`) appear here — but this module DOES use `fetch`,
// `Request`, `ReadableStream` and (through ./sse) `TextDecoder`, which are runtime
// globals rather than DOM APIs. Recorded caveat for the 4.3 mobile unfreeze (D12):
// React Native's fetch does NOT expose a streaming response body, which is exactly
// D12's trigger for a collected-JSON `?stream=false` mode. The rest of this module
// (the seam, the taxonomy, the frame grammar) ports unchanged.
//
// AUTH: there is no second token source. `fetch` is the SAME injected seam
// `createApiClient` takes (`client.ts:12`) — callers pass `coordinator.authFetch`,
// so the bearer, the single silent 401->refresh->retry and the AM-7 body
// preserving clone all come from the shipped coordinator. `authFetch` clones the
// request BEFORE sending and returns the Response untouched, so the streaming body
// is never consumed by the auth layer.
import { ApiError } from './errors';
import { createSseFrameParser, type SseFrame } from './sse';
import type { components, paths } from './generated/schema';

export type AdvisorAsk = components['schemas']['AdvisorAsk'];
export type AdvisorTurn = components['schemas']['AdvisorTurn'];

// `satisfies keyof paths` binds this string to the contract without importing a
// value from the generated module.
const ADVISOR_ASK_PATH = '/advisor/ask' satisfies keyof paths;

/**
 * What the caller sees. Deliberately NOT the raw frames: `delta` carries decoded
 * text, and the two synthetic details below are the client's half of the D9
 * protocol obligations.
 *
 *   STREAM_INCOMPLETE — the stream ended without a terminal frame (a drop). The
 *                       partial answer is real and stays on screen.
 *   STREAM_MALFORMED  — a frame could not be understood. Skipping it silently
 *                       would turn a protocol break into a truncated answer the
 *                       user believes.
 */
export type AdvisorStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done' }
  | { type: 'error'; detail: string };

export interface AskAdvisorOptions {
  baseUrl: string;
  /** The injected-fetch seam — pass `coordinator.authFetch`. */
  fetch: (input: Request) => Promise<Response>;
  body: AdvisorAsk;
  signal?: AbortSignal;
}

type FrameOutcome =
  | { kind: 'event'; event: AdvisorStreamEvent; terminal: boolean }
  | { kind: 'ignore' };

function parseFrameData(data: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

const MALFORMED: FrameOutcome = {
  kind: 'event',
  event: { type: 'error', detail: 'STREAM_MALFORMED' },
  terminal: true,
};

function interpretFrame(frame: SseFrame): FrameOutcome {
  switch (frame.event) {
    case 'delta': {
      const payload = parseFrameData(frame.data);
      const text = payload?.['text'];
      if (typeof text !== 'string') return MALFORMED;
      return { kind: 'event', event: { type: 'delta', text }, terminal: false };
    }
    case 'done':
      // `data: {}` — nothing to read, so an unparseable payload is still a valid
      // "the answer finished" signal and must not be reported as a break.
      return { kind: 'event', event: { type: 'done' }, terminal: true };
    case 'error': {
      const payload = parseFrameData(frame.data);
      const detail = payload?.['detail'];
      if (typeof detail !== 'string') return MALFORMED;
      return { kind: 'event', event: { type: 'error', detail }, terminal: true };
    }
    default:
      // Unknown event names (a future heartbeat, the default "message") are
      // ignored — forward compatibility, not a protocol break.
      return { kind: 'ignore' };
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Stream one advisor answer.
 *
 * Failure taxonomy — two channels, deliberately:
 *   * PRE-STREAM (`!response.ok`): the body is read as text, best-effort
 *     JSON.parsed (what openapi-fetch does) and thrown as `ApiError(status, body)`
 *     — so 503 AI_NOT_CONFIGURED / 429 RATE_LIMITED flow into the shipped
 *     `getErrorCode` machinery unchanged.
 *   * MID-STREAM: a 200 was already sent, so the status can no longer change —
 *     the `error` frame IS the channel (D9), yielded as `{type:'error', detail}`.
 *
 * ABORT is NOT a failure: when `signal` fires, the generator simply completes
 * with no terminal event. The UI's `stopped` state depends on that distinction
 * (an intentional stop must not read as a broken answer).
 */
export async function* askAdvisor(
  options: AskAdvisorOptions,
): AsyncGenerator<AdvisorStreamEvent> {
  const { baseUrl, fetch: doFetch, body, signal } = options;

  const request = new Request(`${baseUrl.replace(/\/+$/, '')}${ADVISOR_ASK_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });

  const response = await doFetch(request);

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let parsed: unknown = text === '' ? undefined : text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Leave `parsed` as the raw text: a non-JSON error body is still evidence.
    }
    throw new ApiError(response.status, parsed);
  }

  // A 200 with no body is a stream that ended before saying anything — the same
  // honest outcome as a mid-answer drop.
  if (response.body === null) {
    yield { type: 'error', detail: 'STREAM_INCOMPLETE' };
    return;
  }

  const reader = response.body.getReader();
  const parser = createSseFrameParser();

  // The signal is on the Request (so a real fetch tears the connection down), but
  // the read is ALSO raced against it: the injected seam may be any transport,
  // and a stop must not depend on the transport honouring the signal.
  let onAbort: (() => void) | undefined;
  const abortSignalled =
    signal === undefined
      ? undefined
      : new Promise<'aborted'>((resolve) => {
          if (signal.aborted) {
            resolve('aborted');
            return;
          }
          onAbort = () => resolve('aborted');
          signal.addEventListener('abort', onAbort, { once: true });
        });

  try {
    for (;;) {
      let result: ReadableStreamReadResult<Uint8Array> | 'aborted';
      try {
        const read = reader.read();
        result =
          abortSignalled === undefined ? await read : await Promise.race([read, abortSignalled]);
      } catch (error) {
        // A real fetch rejects the pending read when the signal fires.
        if (signal?.aborted === true || isAbortError(error)) return;
        // Anything else is the connection dying mid-answer: the partial text is
        // real, so this is a drop, not a thrown network error.
        yield { type: 'error', detail: 'STREAM_INCOMPLETE' };
        return;
      }
      if (result === 'aborted') return;

      // End of stream: flush first — a frame completed by the final terminator is
      // still a real frame — then fall out to the drop branch below.
      const frames = result.done ? parser.flush() : parser.push(result.value);
      for (const frame of frames) {
        const outcome = interpretFrame(frame);
        if (outcome.kind === 'ignore') continue;
        yield outcome.event;
        // Exactly one terminal frame is emitted (D9): stop reading at it, so
        // nothing after it can reach the caller.
        if (outcome.terminal) return;
      }
      if (result.done) break;
    }

    // The stream closed with no `done` and no `error` frame — D9's explicit
    // client obligation: say so instead of presenting a truncated answer as final.
    yield { type: 'error', detail: 'STREAM_INCOMPLETE' };
  } finally {
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
    // Release the connection on every exit path: terminal frame, abort, or the
    // caller walking away from the generator (which runs this `finally`).
    await reader.cancel().catch(() => undefined);
  }
}
