import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { useT } from '../i18n/context';
import { shouldConfirmDiscard } from '../lib/discardGuard';
import { Button } from './Button';
import styles from './Modal.module.css';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  // Disables the header × button (real `disabled` attribute) — used while a
  // confirm mutation is pending so the button is not enabled-but-dead.
  closeDisabled?: boolean;
  // P2 (WR-11): when the hosted form has unsaved edits, all three close channels
  // ask before throwing them away. Default false = the shipped behaviour for
  // every modal that does not pass it.
  isDirty?: boolean;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

// The focus trap must not walk into the form that the discard panel hides: the
// children stay MOUNTED (unmounting them would destroy the very values the guard
// exists to protect) behind `hidden`, so they are still in the DOM and still
// match the selector above.
function isVisible(element: HTMLElement): boolean {
  return element.checkVisibility?.() ?? element.offsetParent !== null;
}

/**
 * Accessible modal dialog (plan): role="dialog" + aria-modal, initial focus into
 * the dialog, a Tab focus-trap, Esc + backdrop close, and focus restoration to the
 * previously focused element on unmount. The parent owns the open/closed state, so
 * `onClose` is the single close channel (Esc, backdrop, and the × button all call it).
 *
 * P2 / WR-11: `isDirty` routes those three channels through one `requestClose()`.
 * When it confirms, the discard panel replaces the BODY inside this SAME dialog —
 * not a nested `ConfirmDialog`, which would mean two document-level Esc handlers
 * and two focus traps fighting, and (worse) would unmount the form and lose every
 * typed value. Esc inside the panel cancels the discard rather than closing: the
 * least destructive reading of a second Esc.
 */
export function Modal({
  title,
  onClose,
  children,
  closeDisabled = false,
  isDirty = false,
}: ModalProps) {
  const t = useT();
  const dialogRef = useRef<HTMLDivElement>(null);
  const discardRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  // Capture + restore focus. Runs once for the modal's lifetime.
  useEffect(() => {
    previouslyFocused.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const dialog = dialogRef.current;
    const firstFocusable = dialog?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (firstFocusable ?? dialog)?.focus();

    return () => {
      previouslyFocused.current?.focus();
    };
  }, []);

  // Opening the discard panel hides the form, which would leave focus on a node
  // that is no longer visible (and, in some browsers, on <body>). Move it onto
  // the panel's first control — a real DOM effect, not state syncing.
  useEffect(() => {
    if (!confirmingDiscard) return;
    const panel = discardRef.current;
    panel?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();
  }, [confirmingDiscard]);

  // The ONE close channel behind all three of Esc, the backdrop and the × button.
  const requestClose = useCallback(() => {
    if (shouldConfirmDiscard(isDirty, closeDisabled)) {
      setConfirmingDiscard(true);
      return;
    }
    onClose();
  }, [isDirty, closeDisabled, onClose]);

  // Esc to close + Tab trap, bound at DOCUMENT level for the modal's lifetime.
  // A React onKeyDown on the dialog would fire only while focus is inside the
  // subtree; Safari does not focus buttons/radios on click, and a disabled
  // element drops focus to <body> — both leave the dialog and would silently
  // kill Esc and let Tab walk into the background. The trap re-enters the dialog
  // whenever focus has escaped it.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        // A second Esc, with the discard panel up, CANCELS the discard: the
        // least destructive reading of "escape" when the question on screen is
        // "throw your edits away?".
        if (confirmingDiscard) {
          setConfirmingDiscard(false);
          return;
        }
        requestClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusables = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter(isVisible);
      if (focusables.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;

      // Focus has left the dialog subtree — or is sitting on a hidden node behind
      // the discard panel — so re-enter at the first VISIBLE focusable.
      if (!(active instanceof HTMLElement) || !dialog.contains(active) || !isVisible(active)) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [requestClose, confirmingDiscard]);

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onMouseDown={(event) => {
        // Close only on a genuine backdrop click, not a drag that ends outside.
        // While the discard panel is up the click is ignored: the panel asks a
        // question, and a stray backdrop click is not an answer to it.
        if (event.target === event.currentTarget && !confirmingDiscard) requestClose();
      }}
    >
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className={styles.header}>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          <button
            type="button"
            className={styles.close}
            onClick={requestClose}
            disabled={closeDisabled || confirmingDiscard}
            aria-label={t('common.close')}
          >
            ×
          </button>
        </header>
        {/* `hidden`, not unmounted: everything typed stays exactly where it was if
            the user chooses to keep editing. */}
        <div className={styles.body} hidden={confirmingDiscard}>
          {children}
        </div>
        {confirmingDiscard ? (
          <div ref={discardRef} className={styles.discard}>
            <p className={styles.discardMessage} role="alert">
              {t('modal.discardMessage')}
            </p>
            <div className={styles.discardActions}>
              <Button variant="secondary" onClick={() => setConfirmingDiscard(false)}>
                {t('modal.keepEditing')}
              </Button>
              <Button variant="danger" onClick={onClose}>
                {t('modal.discardConfirm')}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
