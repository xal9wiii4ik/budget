import type { ReactNode } from 'react';

import { ThemeToggle } from '../theme/ThemeToggle';
import styles from './AuthLayout.module.css';

interface AuthLayoutProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}

/** Centered auth card shell shared by the login and register screens (E19). */
export function AuthLayout({ title, subtitle, children, footer }: AuthLayoutProps) {
  return (
    <main className={styles.page}>
      <div className={styles.themeCorner}>
        <ThemeToggle />
      </div>
      <div className={styles.card}>
        <span className={styles.brand}>Budget</span>
        <h1 className={styles.title}>{title}</h1>
        {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
        {children}
        {footer ? <div className={styles.footer}>{footer}</div> : null}
      </div>
    </main>
  );
}
