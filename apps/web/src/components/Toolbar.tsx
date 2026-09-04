import type { ComponentProps } from 'react';

import styles from './Toolbar.module.css';

interface ToolbarProps extends ComponentProps<'div'> {
  justify?: 'start' | 'between' | 'end';
}

/**
 * A row of controls (filters, search, actions) that WRAPS instead of overflowing.
 * Not a <nav> and not a landmark — callers that need one pass their own element
 * around it or an aria-label through `rest`.
 */
export function Toolbar({ justify = 'start', className, ...rest }: ToolbarProps) {
  return (
    <div
      className={[styles.toolbar, styles[justify], className].filter(Boolean).join(' ')}
      {...rest}
    />
  );
}
