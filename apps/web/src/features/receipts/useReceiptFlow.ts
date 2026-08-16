// The photo -> receipt state machine (S5).
//
// PM amendment 2026-07-28: a successful upload does NOT auto-parse. It lands on a
// TWO-ACTION choice — "Save" (stop here, zero AI cost, the stored receipt is then
// attachable to a manually created transaction) or "Scan with AI" (parse + poll).
// So the machine is:
//
//   idle -> downscaling -> creating -> uploading -> uploaded
//                                                    |-> saved                (terminal)
//                                                    '-> parsing -> polling -> ready
//                                                                          |-> timedout
//                                                                          '-> error
//
// Two kinds of state live here and they are kept apart on purpose:
//   * the STEP the user is on is transient client state -> useReducer, dies with
//     the modal (never Zustand: one component, one session);
//   * the receipt ROW is server state -> TanStack Query, and the poll's outcome
//     (ready / failed / timed out) is DERIVED during render from the query rather
//     than copied into the reducer by an effect. One source of truth, no sync.
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import type { components } from '@budget/api-client';

import {
  useCreateReceipt,
  useParseReceipt,
  useReceiptPoll,
  uploadToPresigned,
  type ReceiptRead,
} from '../../data/receipts';
import { qk } from '../../data/queryKeys';
import { describeReceiptError, receiptErrorMessage } from '../../lib/errors';
import { ApiError } from '../../lib/query';
import { DownscaleError, downscaleToJpeg, type DownscaleFailure } from './downscale';
import { pollInterval } from './pollInterval';

type ReceiptCreated = components['schemas']['ReceiptCreated'];

/**
 * What the "Try again" button does — R5's retry granularity, refined by what can
 * actually succeed on a second press:
 *   reparse  — the object is uploaded, only the read failed: re-POST /parse.
 *   reupload — the upload leg is the suspect: re-run from downscale with the SAME
 *              file (create + PUT again).
 *   none     — retrying is futile (a rejected image, a server with no AI key, a
 *              receipt that no longer exists): the panel offers the manual path
 *              or a new photo instead of a button that cannot help.
 */
export type RetryMode = 'reparse' | 'reupload' | 'none';

export type ReceiptFlowState =
  | { status: 'idle' }
  | { status: 'downscaling' }
  | { status: 'creating' }
  | { status: 'uploading' }
  | { status: 'uploaded'; receiptId: string }
  | { status: 'saved'; receiptId: string }
  | { status: 'parsing'; receiptId: string }
  | { status: 'polling'; receiptId: string }
  | { status: 'ready'; receiptId: string; receipt: ReceiptRead }
  | { status: 'timedout'; receiptId: string }
  | { status: 'error'; message: string; retry: RetryMode; receiptId: string | null };

// Reducer state = the machine only. `ready`/`timedout` are absent: they are
// properties of the polled row, derived below.
type Phase =
  | { kind: 'idle' }
  | { kind: 'downscaling' }
  | { kind: 'creating' }
  | { kind: 'uploading'; receiptId: string }
  | { kind: 'uploaded'; receiptId: string }
  | { kind: 'saved'; receiptId: string }
  | { kind: 'parsing'; receiptId: string }
  | { kind: 'polling'; receiptId: string; startedAt: number }
  | { kind: 'error'; message: string; retry: RetryMode; receiptId: string | null };

type Action =
  | { type: 'reset' }
  | { type: 'downscaling' }
  | { type: 'creating' }
  | { type: 'uploading'; receiptId: string }
  | { type: 'uploaded' }
  | { type: 'saved' }
  | { type: 'parsing' }
  | { type: 'polling'; startedAt: number }
  | { type: 'failed'; message: string; retry: RetryMode; receiptId: string | null };

function phaseReceiptId(phase: Phase): string | null {
  return 'receiptId' in phase ? phase.receiptId : null;
}

function reduce(phase: Phase, action: Action): Phase {
  switch (action.type) {
    case 'reset':
      return { kind: 'idle' };
    case 'downscaling':
      return { kind: 'downscaling' };
    case 'creating':
      return { kind: 'creating' };
    case 'uploading':
      return { kind: 'uploading', receiptId: action.receiptId };
    // The steps below can only follow a phase that already carries the id, so
    // they carry it forward instead of re-passing it from the caller.
    case 'uploaded': {
      const receiptId = phaseReceiptId(phase);
      return receiptId ? { kind: 'uploaded', receiptId } : phase;
    }
    case 'saved': {
      const receiptId = phaseReceiptId(phase);
      return receiptId ? { kind: 'saved', receiptId } : phase;
    }
    case 'parsing': {
      const receiptId = phaseReceiptId(phase);
      return receiptId ? { kind: 'parsing', receiptId } : phase;
    }
    case 'polling': {
      const receiptId = phaseReceiptId(phase);
      return receiptId ? { kind: 'polling', receiptId, startedAt: action.startedAt } : phase;
    }
    case 'failed':
      return {
        kind: 'error',
        message: action.message,
        retry: action.retry,
        receiptId: action.receiptId,
      };
  }
}

// A rejected/undecodable image cannot be fixed by pressing a button — the user
// needs a different photo, so these end in `retry: 'none'` and the panel shows
// the dropzone again instead of a promise that cannot be kept.
function describeDownscaleFailure(reason: DownscaleFailure): string {
  switch (reason) {
    case 'not-an-image':
      return 'That file is not an image. Pick a photo or a screenshot.';
    case 'source-too-large':
      return 'That file is too big to open here. Pick a smaller photo.';
    case 'decode-failed':
      return "Couldn't open that image. Try a different photo.";
    case 'encode-failed':
      return "Couldn't prepare that image on this device. Try a different photo.";
  }
}

// Which failures a second press can plausibly fix, and how. Anything not listed
// (including an unknown code and the network fallback) is treated as a transient
// failure of the read, so it retries the read.
function retryModeForParse(code: string | undefined): RetryMode {
  // Nothing a second press can change: no key on the server (same 503 every
  // time), an image the server rejected (the read is not the problem), or a
  // receipt that no longer exists (nothing left to parse or poll).
  switch (code) {
    case 'AI_NOT_CONFIGURED':
    case 'IMAGE_TOO_LARGE':
    case 'RECEIPT_NOT_FOUND':
      return 'none';
    case 'RECEIPT_NOT_UPLOADED':
      return 'reupload';
    default:
      return 'reparse';
  }
}

export interface ReceiptFlow {
  state: ReceiptFlowState;
  /** Start from a picked/dropped file. */
  start: (file: File) => void;
  /** "Scan with AI" — the only call that costs anything. */
  scan: () => void;
  /** "Save" — keep the uploaded receipt as-is: no parse, no AI cost. */
  save: () => void;
  /** Act on the current failure per its retry mode. */
  retry: () => void;
  /** Back to the dropzone (also drops the polled row from the cache). */
  reset: () => void;
}

export function useReceiptFlow(): ReceiptFlow {
  const [phase, dispatch] = useReducer(reduce, { kind: 'idle' });
  const queryClient = useQueryClient();
  // mutateAsync is a stable reference in TanStack Query v5, so the callbacks
  // below stay stable across renders (the mutation OBJECT is not).
  const { mutateAsync: createReceipt } = useCreateReceipt();
  const { mutateAsync: parseReceipt } = useParseReceipt();

  const receiptId = phaseReceiptId(phase);

  // The picked file, kept for a 'reupload' retry so the user does not have to
  // find the photo again after a flaky upload.
  const fileRef = useRef<File | null>(null);
  // Every start/scan/retry/reset takes a token; an async continuation from an
  // abandoned run (double click, retry while the old promise is in flight)
  // checks it before dispatching, so a stale step can never overwrite a live one.
  const runRef = useRef(0);
  // Mirrors the current receipt id for the UNMOUNT cleanup, which must not
  // re-subscribe on every phase change (that would drop the cache mid-poll).
  const receiptIdRef = useRef<string | null>(null);
  useEffect(() => {
    receiptIdRef.current = receiptId;
  }, [receiptId]);

  // The receipt cache is per-session and worthless once the modal is gone (there
  // is no receipts list to feed). Dropping it also stops any poll.
  useEffect(() => {
    return () => {
      const openId = receiptIdRef.current;
      if (openId) {
        queryClient.removeQueries({ queryKey: qk.receipt(openId) });
      }
    };
  }, [queryClient]);

  const poll = useReceiptPoll(
    phase.kind === 'polling' ? phase.receiptId : null,
    phase.kind === 'polling' ? phase.startedAt : 0,
  );

  const startParse = useCallback(
    async (id: string, run: number) => {
      dispatch({ type: 'parsing' });
      try {
        await parseReceipt(id);
        if (runRef.current !== run) return;
        dispatch({ type: 'polling', startedAt: Date.now() });
      } catch (error) {
        if (runRef.current !== run) return;
        const { code, message } = describeReceiptError(error);
        // Both 409s mean the server is AHEAD of us, not that something broke:
        // ALREADY_PARSED -> the row is done, PROCESSING -> a read is running.
        // Either way the GET tells the truth, so resume polling instead of
        // showing an error for work that is going fine.
        if (code === 'RECEIPT_ALREADY_PARSED' || code === 'RECEIPT_PROCESSING') {
          dispatch({ type: 'polling', startedAt: Date.now() });
          return;
        }
        dispatch({ type: 'failed', message, retry: retryModeForParse(code), receiptId: id });
      }
    },
    [parseReceipt],
  );

  const startUpload = useCallback(
    async (file: File, run: number) => {
      dispatch({ type: 'downscaling' });
      let blob: Blob;
      try {
        blob = await downscaleToJpeg(file);
      } catch (error) {
        if (runRef.current !== run) return;
        dispatch({
          type: 'failed',
          message:
            error instanceof DownscaleError
              ? describeDownscaleFailure(error.reason)
              : "Couldn't prepare that image. Try a different photo.",
          retry: 'none',
          receiptId: null,
        });
        return;
      }
      if (runRef.current !== run) return;

      dispatch({ type: 'creating' });
      let created: ReceiptCreated;
      try {
        created = await createReceipt();
      } catch (error) {
        if (runRef.current !== run) return;
        // Our own API: the envelope carries a code (429 RATE_LIMITED above all),
        // so the mapped message is the right one.
        dispatch({
          type: 'failed',
          message: describeReceiptError(error).message,
          retry: 'reupload',
          receiptId: null,
        });
        return;
      }
      if (runRef.current !== run) return;

      dispatch({ type: 'uploading', receiptId: created.id });
      try {
        await uploadToPresigned(created.upload, blob);
        if (runRef.current !== run) return;
        dispatch({ type: 'uploaded' });
      } catch (error) {
        if (runRef.current !== run) return;
        // Storage answers with XML, not our {detail: CODE} envelope, so a non-2xx
        // carries no code to map — only "couldn't reach it" (a rejected fetch) is
        // distinguishable, and describeReceiptError already says exactly that.
        // The retry re-runs the whole leg with a fresh presign: the id issued for
        // this attempt is dropped because its row has no object behind it.
        dispatch({
          type: 'failed',
          message:
            error instanceof ApiError
              ? "The photo couldn't be uploaded. Try again."
              : describeReceiptError(error).message,
          retry: 'reupload',
          receiptId: null,
        });
      }
    },
    [createReceipt],
  );

  const start = useCallback(
    (file: File) => {
      fileRef.current = file;
      runRef.current += 1;
      void startUpload(file, runRef.current);
    },
    [startUpload],
  );

  const scan = useCallback(() => {
    if (!receiptId) return;
    runRef.current += 1;
    void startParse(receiptId, runRef.current);
  }, [receiptId, startParse]);

  const save = useCallback(() => {
    runRef.current += 1;
    dispatch({ type: 'saved' });
  }, []);

  const reset = useCallback(() => {
    runRef.current += 1;
    if (receiptId) {
      queryClient.removeQueries({ queryKey: qk.receipt(receiptId) });
    }
    fileRef.current = null;
    dispatch({ type: 'reset' });
  }, [queryClient, receiptId]);

  // Derive the public state. Everything about the polled row is read from the
  // query here rather than mirrored into the reducer by an effect.
  let state: ReceiptFlowState;
  switch (phase.kind) {
    case 'idle':
    case 'downscaling':
    case 'creating':
      state = { status: phase.kind };
      break;
    case 'uploading':
      state = { status: 'uploading' };
      break;
    case 'uploaded':
    case 'saved':
    case 'parsing':
      state = { status: phase.kind, receiptId: phase.receiptId };
      break;
    case 'error':
      state = {
        status: 'error',
        message: phase.message,
        retry: phase.retry,
        receiptId: phase.receiptId,
      };
      break;
    case 'polling': {
      const polledId = phase.receiptId;
      if (poll.isError) {
        const { code, message } = describeReceiptError(poll.error);
        state = { status: 'error', message, retry: retryModeForParse(code), receiptId: polledId };
      } else if (poll.data?.status === 'parsed') {
        state = { status: 'ready', receiptId: polledId, receipt: poll.data };
      } else if (poll.data?.status === 'failed') {
        state = {
          status: 'error',
          // `receipt.error` is an untyped string on the contract: known codes get
          // their message, anything else falls through to the generic one.
          message: receiptErrorMessage(poll.data.error ?? ''),
          retry: 'reparse',
          receiptId: polledId,
        };
      } else if (
        // The same pure rule the query uses to stop refetching, evaluated against
        // the last SETTLED fetch (not Date.now(), which would make render impure
        // and could disagree with the query's own decision).
        pollInterval(poll.data?.status, Math.max(poll.dataUpdatedAt - phase.startedAt, 0)) === false
      ) {
        state = { status: 'timedout', receiptId: polledId };
      } else {
        state = { status: 'polling', receiptId: polledId };
      }
      break;
    }
  }

  const retry = useCallback(() => {
    if (state.status === 'timedout') {
      runRef.current += 1;
      void startParse(state.receiptId, runRef.current);
      return;
    }
    if (state.status !== 'error') return;
    if (state.retry === 'reparse' && state.receiptId) {
      runRef.current += 1;
      void startParse(state.receiptId, runRef.current);
      return;
    }
    if (state.retry === 'reupload' && fileRef.current) {
      start(fileRef.current);
    }
  }, [state, startParse, start]);

  return { state, start, scan, save, retry, reset };
}
