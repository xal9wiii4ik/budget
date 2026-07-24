import { useEffect, useId, useRef, type ReactNode } from 'react';

import styles from './Modal.module.css';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  // Disables the header × button (real `disabled` attribute) — used while a
  // confirm mutation is pending so the button is not enabled-but-dead.
  closeDisabled?: boolean;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Accessible modal dialog (plan): role="dialog" + aria-modal, initial focus into
 * the dialog, a Tab focus-trap, Esc + backdrop close, and focus restoration to the
 * previously focused element on unmount. The parent owns the open/closed state, so
 * `onClose` is the single close channel (Esc, backdrop, and the × button all call it).
 */
export function Modal({ title, onClose, children, closeDisabled = false }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const titleId = useId();

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
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusables.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;

      // Focus has left the dialog subtree — re-enter at the first focusable.
      if (!(active instanceof Node) || !dialog.contains(active)) {
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
  }, [onClose]);

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onMouseDown={(event) => {
        // Close only on a genuine backdrop click, not a drag that ends outside.
        if (event.target === event.currentTarget) onClose();
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
            onClick={onClose}
            disabled={closeDisabled}
            aria-label="Close"
          >
            ×
          </button>
        </header>
        <div className={styles.body}>{children}</div>
      </div>
    </div>
  );
}
