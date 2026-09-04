import type { ComponentProps } from 'react';

import styles from './Card.module.css';

interface CardProps extends ComponentProps<'div'> {
  /** Padding step. 'none' is for cards whose children run to the edges (lists). */
  size?: 'none' | 'sm' | 'md' | 'lg';
}

/**
 * A surface with a hairline border — the app's one "raised block on the page"
 * primitive. Shadows are deliberately not part of it: depth here is a tone and a
 * border, and a shadow is reserved for things that genuinely float (modals).
 */
export function Card({ size = 'md', className, ...rest }: CardProps) {
  return (
    <div className={[styles.card, styles[size], className].filter(Boolean).join(' ')} {...rest} />
  );
}
