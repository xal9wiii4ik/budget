import type { ComponentProps } from 'react';

import styles from './Button.module.css';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md';

// ComponentProps (not …WithoutRef): react-hook-form and focus management hand a
// ref in as an ordinary prop under React 19, and every native button attribute
// (form, name, aria-*, disabled) passes straight through `rest`.
interface ButtonProps extends ComponentProps<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** In-flight action: disabled + aria-busy. The LABEL is the caller's business —
   *  screens already swap "Save"/"Saving…" from their own dictionaries. */
  loading?: boolean;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  className,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  const classes = [styles.button, styles[size], styles[variant], className]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type={type}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    />
  );
}
