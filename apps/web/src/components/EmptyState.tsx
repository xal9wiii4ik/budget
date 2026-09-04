import type { ReactNode } from 'react';

import styles from './EmptyState.module.css';

interface EmptyStateProps {
  title: ReactNode;
  /** What to do next — an empty state that only says "no data" is a dead end. */
  description?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
  className?: string;
}

export function EmptyState({ title, description, actions, icon, className }: EmptyStateProps) {
  return (
    <div className={className ? `${styles.empty} ${className}` : styles.empty}>
      {icon ? (
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <p className={styles.title}>{title}</p>
      {description ? <p className={styles.description}>{description}</p> : null}
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </div>
  );
}
