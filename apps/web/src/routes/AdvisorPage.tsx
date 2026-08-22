import { Link } from 'react-router';

import { AdvisorChat } from '../features/advisor/AdvisorChat';
import { useT } from '../i18n/context';
import styles from './AdvisorPage.module.css';

/**
 * The advisor screen (4.4 W3). A dedicated route rather than a modal on /stats
 * (ruling R8): a modal would lose the transcript on close, put a focus trap around
 * a streaming region and leave the composer no room.
 *
 * Since the i18n scope the PANEL follows the app's language like every other
 * screen. What is NOT translated is the conversation itself: the model answers in
 * whatever language it answers in, and that text is rendered verbatim.
 */
export function AdvisorPage() {
  const t = useT();
  return (
    <section className={styles.page}>
      <div className={styles.toolbar}>
        <h1 className={styles.title}>{t('advisor.title')}</h1>
        <Link className={styles.statsLink} to="/stats">
          {t('advisor.toStats')}
        </Link>
      </div>
      <p className={styles.lead}>{t('advisor.lead')}</p>
      <AdvisorChat />
    </section>
  );
}
