import { useEffect, useRef, useState } from 'react';

import { ReceiptDropzone } from '../receipts/ReceiptDropzone';
import { useReceiptFlow } from '../receipts/useReceiptFlow';
import { useReceipt } from '../../data/receipts';
import styles from './AttachPhotoField.module.css';

interface AttachPhotoFieldProps {
  /** The receipt this operation is linked to, or null. Owned by the form. */
  receiptId: string | null;
  onChange: (receiptId: string | null) => void;
  /** True while the transaction is being saved — no re-linking mid-flight. */
  disabled?: boolean;
}

/**
 * "Attach a photo" inside the transaction form (transaction-details-and-i18n S3).
 *
 * The one thing this control must never do is drag AI into a photo. Attaching and
 * READING are separate features: the presign has no AI gate, and `useReceiptFlow`
 * already terminates on `saved` — an uploaded receipt with no parse. So this
 * field drives the flow only as far as `saved` and never calls `scan()`; on a
 * server with no AI key it works exactly the same, with no 503 anywhere.
 *
 * Reused wholesale, not reimplemented: the flow owns downscaling, the presigned
 * PUT, its retry granularity and its error copy (features/receipts).
 *
 * Detaching removes the LINK only. The stored file is not deleted — there is no
 * delete endpoint and this scope adds none — so the copy says "remove from this
 * operation", which is what actually happens.
 */
export function AttachPhotoField({ receiptId, onChange, disabled = false }: AttachPhotoFieldProps) {
  const flow = useReceiptFlow();
  const [picking, setPicking] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  // The picked file rendered from memory. It exists only for the photo attached
  // in THIS session: a receipt uploaded earlier has no readable URL on the
  // contract (there is no presigned GET), and inventing one would be a broken
  // <img> on every edit.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const previewRef = useRef<string | null>(null);

  const setPreview = (file: File | null) => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    const url = file === null ? null : URL.createObjectURL(file);
    previewRef.current = url;
    setPreviewUrl(url);
  };

  // Object URLs are a real external resource, so they are released on unmount —
  // the one honest use of an effect here.
  useEffect(() => {
    return () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    };
  }, []);

  // The upload's terminal step. `uploaded` is the flow asking "parse or keep?" —
  // this field always answers "keep" (`save()`), which is what makes attaching
  // free of AI. Runs once per upload: `save()` moves the flow off `uploaded`.
  const { state, save } = flow;
  useEffect(() => {
    if (state.status !== 'uploaded') return;
    save();
    onChange(state.receiptId);
  }, [state, save, onChange]);

  // The attached receipt's own row — shown as its status, never as a promise of
  // a picture we cannot fetch. An error here is not the user's problem: the link
  // is stored on the transaction either way, so it degrades to the plain
  // "photo attached" line.
  const receipt = useReceipt(receiptId);

  const busy =
    state.status === 'downscaling' || state.status === 'creating' || state.status === 'uploading';

  const onFile = (file: File) => {
    setPreview(file);
    flow.start(file);
  };

  const removePhoto = () => {
    setConfirmingRemove(false);
    setPicking(false);
    setPreview(null);
    flow.reset();
    onChange(null);
  };

  return (
    <div className={styles.field}>
      <span className={styles.label} id="tx-photo-label">
        Photo <span className={styles.hint}>(optional)</span>
      </span>

      {/* Four states, side by side rather than nested, because they compose: a
          photo can be attached WHILE another one is being uploaded to replace
          it. Empty / uploading / error / attached — none of them hides the
          others' information. */}
      <div className={styles.states} role="group" aria-labelledby="tx-photo-label">
        {receiptId !== null ? (
          <div className={styles.attached}>
            {previewUrl ? (
              <img className={styles.thumb} src={previewUrl} alt="The photo you attached" />
            ) : null}
            <div className={styles.attachedText}>
              <p className={styles.attachedTitle}>
                Photo attached
                {receipt.data?.status === 'parsed' ? ' · already scanned' : ''}
              </p>
              <p className={styles.hint}>
                {receipt.isError
                  ? "We couldn't load this photo's details, but it is still linked to this operation."
                  : 'It stays with this operation. Removing it here only unlinks it.'}
              </p>
            </div>
            {confirmingRemove ? (
              // Inline, not a nested ConfirmDialog: a second dialog inside this
              // one would mean two focus traps and two Esc handlers fighting
              // (see components/Modal), and it would cover the form the user is
              // in the middle of filling in.
              <div className={styles.confirm} role="group" aria-label="Remove the photo?">
                <span className={styles.confirmText}>Remove it from this operation?</span>
                <button
                  type="button"
                  className={styles.remove}
                  onClick={removePhoto}
                  disabled={disabled}
                >
                  Remove
                </button>
                <button
                  type="button"
                  className={styles.secondary}
                  onClick={() => setConfirmingRemove(false)}
                >
                  Keep it
                </button>
              </div>
            ) : (
              <button
                type="button"
                className={styles.secondary}
                onClick={() => setConfirmingRemove(true)}
                disabled={disabled}
              >
                Remove
              </button>
            )}
          </div>
        ) : null}

        {busy ? (
          <p className={styles.progress} role="status">
            {state.status === 'downscaling'
              ? 'Preparing the photo…'
              : state.status === 'creating'
                ? 'Getting ready to upload…'
                : 'Uploading…'}
          </p>
        ) : null}

        {state.status === 'error' ? (
          <p className={styles.error} role="alert">
            {state.message}{' '}
            {state.retry !== 'none' ? (
              <button type="button" className={styles.linkButton} onClick={flow.retry}>
                Try again
              </button>
            ) : null}
          </p>
        ) : null}

        {picking && !busy ? (
          <>
            <ReceiptDropzone onFile={onFile} />
            <button type="button" className={styles.secondary} onClick={() => setPicking(false)}>
              Cancel
            </button>
          </>
        ) : null}

        {!picking && !busy ? (
          <button
            type="button"
            className={styles.secondary}
            onClick={() => setPicking(true)}
            disabled={disabled}
          >
            {receiptId === null ? 'Attach a photo' : 'Replace the photo'}
          </button>
        ) : null}
      </div>
    </div>
  );
}
