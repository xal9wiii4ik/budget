import type { ComponentProps, ReactNode } from 'react';

import styles from './Field.module.css';

interface FieldProps {
  label: ReactNode;
  /** The control's id — the label points at it, so it is required, not optional. */
  htmlFor: string;
  hint?: ReactNode;
  /** Id for the hint paragraph, when the control references it via aria-describedby. */
  hintId?: string;
  /** Already-resolved message. Rendered as role="alert", as every form here does. */
  error?: string;
  children: ReactNode;
  className?: string;
}

/** Label + control + hint + error, in the order the shipped forms use them. */
export function Field({ label, htmlFor, hint, hintId, error, children, className }: FieldProps) {
  return (
    <div className={className ? `${styles.field} ${className}` : styles.field}>
      <label className={styles.label} htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint ? (
        <p className={styles.hint} id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/* The three controls are plain natives with the app's input styling — nothing is
   re-implemented, so `register()` spreads onto them unchanged (ref included). */

export function Input({ className, ...rest }: ComponentProps<'input'>) {
  return <input className={[styles.control, className].filter(Boolean).join(' ')} {...rest} />;
}

export function Select({ className, ...rest }: ComponentProps<'select'>) {
  return (
    <select
      className={[styles.control, styles.select, className].filter(Boolean).join(' ')}
      {...rest}
    />
  );
}

export function Textarea({ className, ...rest }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={[styles.control, styles.textarea, className].filter(Boolean).join(' ')}
      {...rest}
    />
  );
}
