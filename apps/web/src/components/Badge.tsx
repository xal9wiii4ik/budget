import type { ComponentProps } from 'react';

import styles from './Badge.module.css';

interface BadgeProps extends ComponentProps<'span'> {
  tone?: 'neutral' | 'accent' | 'success' | 'danger' | 'warning';
}

/** A status pill. Colour is a TONE, never the sentence: the text says what it means. */
export function Badge({ tone = 'neutral', className, ...rest }: BadgeProps) {
  return (
    <span className={[styles.badge, styles[tone], className].filter(Boolean).join(' ')} {...rest} />
  );
}
