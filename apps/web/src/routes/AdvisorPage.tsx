import { Link } from 'react-router';

import { AdvisorChat } from '../features/advisor/AdvisorChat';
import styles from './AdvisorPage.module.css';

/**
 * The advisor screen (4.4 W3). A dedicated route rather than a modal on /stats
 * (ruling R8): a modal would lose the transcript on close, put a focus trap around
 * a streaming region and leave the composer no room.
 *
 * Russian panel in an English shell, deliberately (R4.2) — the conversation and
 * the binding error copy are Russian; app-wide localization is a recorded
 * carry-forward, not this scope.
 */
export function AdvisorPage() {
  return (
    <section className={styles.page}>
      <div className={styles.toolbar}>
        <h1 className={styles.title}>AI-советник</h1>
        <Link className={styles.statsLink} to="/stats">
          К статистике
        </Link>
      </div>
      <p className={styles.lead}>
        Ответы строятся по вашим тратам за последние месяцы, категориям и целям.
        История разговора хранится только на этой странице.
      </p>
      <AdvisorChat />
    </section>
  );
}
