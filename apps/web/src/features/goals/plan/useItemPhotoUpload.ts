// One photo, from a picked file to a confirmed attachment.
//
// The receipts machine (`features/receipts/useReceiptFlow.ts`) minus the OCR
// half, and deliberately built out of ITS parts — `downscaleToJpeg` and
// `uploadToPresigned` — rather than a second upload mechanism: presign → PUT →
// confirm is one thing this app knows how to do, and two implementations of it
// would drift on exactly the details (EXIF orientation, the advisory
// Content-Type, what a rejected fetch means) that are invisible until they are
// wrong.
//
// Downscaling is kept for three reasons, not out of symmetry: the server's
// ceiling is the SAME `receipt_max_bytes` (5 MB) that a phone photo blows
// through; the presigned PUT is signed with an `image/jpeg` Content-Type, so a
// PNG screenshot uploaded raw would be served back under a type it is not; and
// the bytes travel from the browser, where the wait is the user's.
//
// The STEP is transient client state (it dies with the details panel); the
// attachment ROWS are server state and stay in the Query cache. The
// two never mirror each other — the only thing this hook publishes about the
// cache is the id it is currently working on, so the list can leave that one row
// to the progress tile instead of drawing it twice.
import { useCallback, useRef, useState } from 'react';

import {
  useConfirmGoalItemFile,
  useCreateGoalItemFile,
  type GoalItemFileCreated,
} from '../../../data/goalItems';
import { uploadToPresigned } from '../../../data/receipts';
import { useLang, useT } from '../../../i18n/context';
import { ApiError } from '../../../lib/query';
import { DownscaleError, downscaleToJpeg } from '../../receipts/downscale';
import {
  MAX_PHOTO_BYTES,
  goalItemFileErrorMessage,
  photoFailureMessage,
  type PhotoFailure,
} from './goalItemFileError';

export type PhotoUploadStep = 'preparing' | 'uploading' | 'confirming';

export type PhotoUploadState =
  | { status: 'idle' }
  /** `fileId` is null until the row is reserved. */
  | { status: 'busy'; step: PhotoUploadStep; fileId: string | null }
  | { status: 'error'; message: string };

export interface ItemPhotoUpload {
  state: PhotoUploadState;
  /** Start from a picked/dropped file. */
  start: (file: File) => void;
  /** Dismiss a failure without picking a new photo. */
  clearError: () => void;
}

function downscaleFailure(error: unknown): PhotoFailure {
  if (!(error instanceof DownscaleError)) return 'prepare-failed';
  switch (error.reason) {
    case 'not-an-image':
      return 'not-an-image';
    case 'source-too-large':
      return 'source-too-large';
    case 'decode-failed':
    case 'encode-failed':
      return 'prepare-failed';
  }
}

export function useItemPhotoUpload(goalId: string, itemId: string): ItemPhotoUpload {
  const t = useT();
  const lang = useLang();
  const [state, setState] = useState<PhotoUploadState>({ status: 'idle' });
  // `mutateAsync` is a stable reference in TanStack Query v5 (the mutation
  // OBJECT is not), so the callbacks below stay stable across renders.
  const { mutateAsync: createFile } = useCreateGoalItemFile(goalId);
  const { mutateAsync: confirmFile } = useConfirmGoalItemFile(goalId);
  // Every start takes a token; a continuation from an abandoned run (a second
  // pick while the first is in flight) checks it before it writes state, so a
  // stale step can never overwrite a live one.
  const runRef = useRef(0);

  const run = useCallback(
    async (file: File, token: number) => {
      const alive = () => runRef.current === token;
      const fail = (message: string) => {
        if (alive()) setState({ status: 'error', message });
      };

      setState({ status: 'busy', step: 'preparing', fileId: null });

      let blob: Blob;
      try {
        blob = await downscaleToJpeg(file);
      } catch (error) {
        fail(photoFailureMessage(downscaleFailure(error), t));
        return;
      }
      if (!alive()) return;
      // The one size gate the client can honestly apply: the server measures the
      // OBJECT, so this is measured on what will actually be uploaded, after the
      // downscale — refusing here beats uploading bytes that confirm will reject.
      if (blob.size > MAX_PHOTO_BYTES) {
        fail(photoFailureMessage('too-large', t));
        return;
      }

      // Whatever leg fails below, the reserved row (if there is one) is left
      // alone and unconfirmed: the list then shows it as a photo that did not
      // finish, with a delete button. Cleaning it up silently would hide a slot
      // that is genuinely taken.
      let created: GoalItemFileCreated;
      try {
        created = await createFile({ itemId });
      } catch (error) {
        fail(goalItemFileErrorMessage(error, t, lang));
        return;
      }
      if (!alive()) return;

      setState({ status: 'busy', step: 'uploading', fileId: created.id });
      try {
        await uploadToPresigned(created.upload, blob);
      } catch (error) {
        // Storage answers with XML, not our {detail: CODE} envelope, so a non-2xx
        // carries no code to map — only "couldn't reach it" (a rejected fetch) is
        // distinguishable, and that is what the network arm says (the receipts
        // precedent).
        fail(
          error instanceof ApiError
            ? photoFailureMessage('upload-failed', t)
            : goalItemFileErrorMessage(error, t, lang),
        );
        return;
      }
      if (!alive()) return;

      setState({ status: 'busy', step: 'confirming', fileId: created.id });
      try {
        await confirmFile({ itemId, fileId: created.id });
      } catch (error) {
        fail(goalItemFileErrorMessage(error, t, lang));
        return;
      }
      if (alive()) setState({ status: 'idle' });
    },
    [confirmFile, createFile, itemId, lang, t],
  );

  const start = useCallback(
    (file: File) => {
      runRef.current += 1;
      void run(file, runRef.current);
    },
    [run],
  );

  const clearError = useCallback(() => {
    runRef.current += 1;
    setState({ status: 'idle' });
  }, []);

  return { state, start, clearError };
}
