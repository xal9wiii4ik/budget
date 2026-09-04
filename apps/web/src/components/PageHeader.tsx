import type { ReactNode } from 'react';

import styles from './PageHeader.module.css';

interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  /** Primary/secondary actions for the screen. Wrap below the title when narrow. */
  actions?: ReactNode;
  className?: string;
}

/** The screen's <h1> line. One per screen — it is what names the page. */
export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <div className={className ? `${styles.header} ${className}` : styles.header}>
      <div className={styles.text}>
        <h1>{title}</h1>
        {description ? <p className={styles.description}>{description}</p> : null}
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </div>
  );
}
