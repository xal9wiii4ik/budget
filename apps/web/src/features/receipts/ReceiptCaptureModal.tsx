import type { components } from '@budget/api-client';
import { useState } from 'react';

import { Modal } from '../../components/Modal';
import type { ReceiptAttachment } from '../transactions/confirmDefaults';
import { TransactionFormModal } from '../transactions/TransactionFormModal';
import { ReceiptDropzone } from './ReceiptDropzone';
import { useReceiptFlow } from './useReceiptFlow';
import styles from './ReceiptCaptureModal.module.css';

type CategoryRead = components['schemas']['CategoryRead'];

interface ReceiptCaptureModalProps {
  month: string; // selected month — the transaction form's base-currency source
  categories: CategoryRead[]; // archived-inclusive set, as the form expects
  onClose: () => void;
}

// Which body the modal shows when the USER asked for the form (R6: the capture
// modal swaps its own body, so the page keeps exactly one modal variant).
// `receipt` undefined is the plain manual escape hatch. A finished AI read does
// NOT go through here — it is derived from the flow state below.
type View = { kind: 'flow' } | { kind: 'form'; receipt?: ReceiptAttachment };

/**
 * "Add by photo": upload a receipt, then choose what to do with it.
 *
 * Product amendment 2026-07-28 — a successful upload does NOT start an AI read.
 * The user picks:
 *   "Save"          the receipt is already stored server-side; stop here, no AI
 *                   call, no cost. It stays attachable to a transaction created
 *                   by hand in this session.
 *   "Scan with AI"  parse + poll, then swap this modal's body for the prefilled
 *                   confirm form (S6/R6) — the page still knows one modal.
 */
export function ReceiptCaptureModal({ month, categories, onClose }: ReceiptCaptureModalProps) {
  const flow = useReceiptFlow();
  const [view, setView] = useState<View>({ kind: 'flow' });

  const { state } = flow;

  // A finished read leads straight to the confirm form — no intermediate
  // "continue" click. DERIVED from the flow state during render, so `ready` is
  // never copied into `view` by an effect (one source of truth).
  const readReceipt: ReceiptAttachment | null =
    state.status === 'ready'
      ? state.receipt.parsed !== null
        ? {
            mode: 'confirm',
            id: state.receiptId,
            parsed: state.receipt.parsed,
            suggestedCategoryId: state.receipt.suggested_category_id,
            suggestionSource: state.receipt.suggestion_source,
          }
        : // The contract allows `parsed: null` on any row, including a parsed one.
          // There is then nothing to prefill, so it degrades to the plain attach
          // form rather than pretending to have read something.
          { mode: 'attach', id: state.receiptId }
      : null;

  if (view.kind === 'form') {
    // The existing create form. In `attach` mode the only difference from a
    // manual add is that the finished transaction carries `receipt_id`.
    return (
      <TransactionFormModal
        month={month}
        categories={categories}
        receipt={view.receipt}
        onClose={onClose}
      />
    );
  }

  if (readReceipt !== null) {
    return (
      <TransactionFormModal
        month={month}
        categories={categories}
        receipt={readReceipt}
        onClose={onClose}
      />
    );
  }

  const busy =
    state.status === 'downscaling' ||
    state.status === 'creating' ||
    state.status === 'uploading' ||
    state.status === 'parsing' ||
    state.status === 'polling';

  const busyLabel =
    state.status === 'downscaling'
      ? 'Preparing the photo…'
      : state.status === 'creating' || state.status === 'uploading'
        ? 'Uploading the photo…'
        : 'Reading the receipt…';

  return (
    <Modal title="Add by photo" onClose={onClose}>
      {/* One panel of a stable minimum height for every step, so the dialog does
          not jump as the flow advances. */}
      <div className={styles.panel}>
        {state.status === 'idle' ? (
          <>
            <ReceiptDropzone onFile={flow.start} />
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.secondary}
                onClick={() => setView({ kind: 'form' })}
              >
                Add manually instead
              </button>
            </div>
          </>
        ) : null}

        {busy ? (
          <div className={styles.progress}>
            <div className={styles.bar} aria-hidden="true">
              <span className={styles.barFill} />
            </div>
            <p className={styles.status} role="status">
              {busyLabel}
            </p>
            {state.status === 'polling' || state.status === 'parsing' ? (
              <p className={styles.hint}>This usually takes a few seconds.</p>
            ) : null}
          </div>
        ) : null}

        {state.status === 'uploaded' ? (
          <div className={styles.choice}>
            <p className={styles.status} role="status">
              Photo uploaded. What should we do with it?
            </p>
            <button type="button" className={styles.primary} onClick={flow.scan}>
              Scan with AI
            </button>
            <p className={styles.hint}>
              Reads the amount, date and merchant off the photo for you.
            </p>
            <button type="button" className={styles.secondary} onClick={flow.save}>
              Save without scanning
            </button>
            <p className={styles.hint}>
              Keeps the photo attached to a transaction you fill in yourself.
            </p>
          </div>
        ) : null}

        {state.status === 'saved' ? (
          <div className={styles.done}>
            <p className={styles.status} role="status">
              Receipt saved.
            </p>
            <p className={styles.hint}>
              Attach it to a transaction now — after you close this window the photo
              can no longer be picked out.
            </p>
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.primary}
                onClick={() =>
                  setView({
                    kind: 'form',
                    receipt: { mode: 'attach', id: state.receiptId },
                  })
                }
              >
                Add transaction with this receipt
              </button>
              <button type="button" className={styles.secondary} onClick={onClose}>
                Close
              </button>
            </div>
          </div>
        ) : null}

        {/* `ready` has no panel: a finished read swaps this modal's body to the
            confirm form above (R6), so there is nothing to click through. */}

        {state.status === 'timedout' ? (
          <div className={styles.failure}>
            <p className={styles.error} role="alert">
              This is taking longer than expected. The photo is uploaded — you can wait
              and try reading it again, or add the transaction yourself.
            </p>
            <div className={styles.actions}>
              <button type="button" className={styles.primary} onClick={flow.retry}>
                Try reading again
              </button>
              <button
                type="button"
                className={styles.secondary}
                onClick={() =>
                  setView({
                    kind: 'form',
                    receipt: { mode: 'attach', id: state.receiptId },
                  })
                }
              >
                Add transaction with this receipt
              </button>
            </div>
          </div>
        ) : null}

        {state.status === 'error' ? (
          <div className={styles.failure}>
            <p className={styles.error} role="alert">
              {state.message}
            </p>
            {state.receiptId === null ? (
              <>
                {/* Nothing was stored, so there is nothing to act on but the
                    photo itself — offer the picker right here rather than
                    behind an extra "choose another photo" click. */}
                {state.retry === 'reupload' ? (
                  <div className={styles.actions}>
                    <button type="button" className={styles.primary} onClick={flow.retry}>
                      Try again
                    </button>
                  </div>
                ) : null}
                <ReceiptDropzone onFile={flow.start} />
              </>
            ) : (
              <div className={styles.actions}>
                {state.retry !== 'none' ? (
                  <button type="button" className={styles.primary} onClick={flow.retry}>
                    Try again
                  </button>
                ) : null}
                {/* The photo IS on the server whenever an id survived the
                    failure, so the manual path stays open — this is the "way
                    forward" the AI_NOT_CONFIGURED case depends on. */}
                <button
                  type="button"
                  className={state.retry === 'none' ? styles.primary : styles.secondary}
                  onClick={() =>
                    setView({
                      kind: 'form',
                      // Re-checked inside the callback: TS drops the narrowing
                      // from the branch condition once it crosses a closure.
                      receipt:
                        state.receiptId === null
                          ? undefined
                          : { mode: 'attach', id: state.receiptId },
                    })
                  }
                >
                  Add transaction with this receipt
                </button>
                <button type="button" className={styles.secondary} onClick={flow.reset}>
                  Choose another photo
                </button>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
