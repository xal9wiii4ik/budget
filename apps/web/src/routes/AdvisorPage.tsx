import { Link } from 'react-router';

import { PageHeader } from '../components/PageHeader';
import { AdvisorChat } from '../features/advisor/AdvisorChat';
import { AdvisorQa } from '../features/advisor/AdvisorQa';
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
 *
 * rag Web A adds a SECOND section under the chat (`AdvisorQa`) rather than a mode
 * of it: a different endpoint, a different seam, a one-shot non-streamed answer
 * and three 503s of its own. The chat stays first because it is the shipped entry
 * point and a returning user's muscle memory; the Q&A is a tool you reach for.
 * The chat itself is untouched by this scope.
 */
export function AdvisorPage() {
  const t = useT();
  return (
    <section className={styles.page}>
      <PageHeader
        className={styles.header}
        title={t('advisor.title')}
        actions={
          <Link className={styles.statsLink} to="/stats">
            {t('advisor.toStats')}
          </Link>
        }
      />
      <p className={styles.lead}>{t('advisor.lead')}</p>
      {/* The chat gets a heading of its own now that it is one of TWO sections:
          without it the page would have an <h1> and then a nameless panel
          followed by a named one. */}
      <section>
        <h2 className={styles.sectionTitle}>{t('advisor.chatTitle')}</h2>
        <AdvisorChat />
      </section>
      <AdvisorQa />
    </section>
  );
}
