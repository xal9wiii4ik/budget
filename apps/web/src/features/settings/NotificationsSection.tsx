import { Button } from '../../components/Button';
import { QueryStateNotice } from '../../components/QueryStateNotice';
import { useT } from '../../i18n/context';
import type { Translate } from '../../i18n/t';
import styles from './SettingsSections.module.css';
import {
  useNotifications,
  type NotificationsOutcome,
} from './useNotifications';

function outcomeText(outcome: NotificationsOutcome, t: Translate): string {
  switch (outcome.kind) {
    case 'test-sent': {
      const sent = t('settings.notifications.testSent', { count: outcome.sent });
      return outcome.removed > 0
        ? `${sent} ${t('settings.notifications.testRemoved', { count: outcome.removed })}`
        : sent;
    }
    case 'test-lost':
      return t('settings.notifications.testLost');
    case 'test-none':
      return t('settings.notifications.testNone');
    case 'server-not-told':
      return t('settings.notifications.serverNotTold');
    case 'key-rotated':
      return t('settings.notifications.keyRotated');
  }
}

/**
 * Push reminders for THIS device (web-push W1): one arm from
 * `notificationsState`, one button for it.
 *
 * Independent of the profile read on purpose — a failed profile must not hide
 * it. Says nothing about amounts because there are none: the reminders carry
 * names only, which the lede promises.
 */
export function NotificationsSection() {
  const t = useT();
  const { view, isIOS, busy, error, outcome, headingRef, enable, disable, sendTest } =
    useNotifications();

  let body;
  if (view.status === 'loading') {
    // Same height as the button row, so nothing jumps when the answers land.
    body = <div className={styles.skeletonControl} aria-hidden="true" />;
  } else if (view.status === 'config-error') {
    body = (
      <QueryStateNotice
        compact
        phase={view.phase}
        message={t('settings.notifications.loadFailed')}
        onRetry={view.retry}
      />
    );
  } else {
    switch (view.arm) {
      case 'ios-not-installed':
        body = <p className={styles.note}>{t('settings.notifications.iosInstall')}</p>;
        break;
      case 'unsupported':
        body = <p className={styles.note}>{t('settings.notifications.unsupported')}</p>;
        break;
      case 'server-off':
        body = <p className={styles.note}>{t('settings.notifications.serverOff')}</p>;
        break;
      case 'denied':
        body = (
          <p className={styles.note}>
            {t(isIOS ? 'settings.notifications.deniedIos' : 'settings.notifications.denied')}
          </p>
        );
        break;
      case 'off':
        body = (
          <div className={styles.row}>
            <span className={styles.status}>{t('settings.notifications.statusOff')}</span>
            <Button
              variant="primary"
              loading={busy === 'enabling'}
              disabled={busy !== null}
              onClick={() => {
                void enable();
              }}
            >
              {t(
                busy === 'enabling'
                  ? 'settings.notifications.enabling'
                  : 'settings.notifications.enable',
              )}
            </Button>
          </div>
        );
        break;
      case 'on':
        body = (
          <div className={styles.row}>
            <span className={styles.status}>{t('settings.notifications.statusOn')}</span>
            <Button
              loading={busy === 'testing'}
              disabled={busy !== null}
              onClick={() => {
                void sendTest();
              }}
            >
              {t(
                busy === 'testing' ? 'settings.notifications.testing' : 'settings.notifications.test',
              )}
            </Button>
            <Button
              variant="ghost"
              loading={busy === 'disabling'}
              disabled={busy !== null}
              onClick={() => {
                void disable();
              }}
            >
              {t(
                busy === 'disabling'
                  ? 'settings.notifications.disabling'
                  : 'settings.notifications.disable',
              )}
            </Button>
          </div>
        );
        break;
    }
  }

  return (
    <section className={styles.section} id="settings-notifications">
      {/* tabIndex -1: the focus target after a click changes the arm (the hook). */}
      <h2 className={styles.title} ref={headingRef} tabIndex={-1}>
        {t('settings.notifications.title')}
      </h2>
      <p className={styles.lede}>{t('settings.notifications.lede')}</p>
      {body}
      {error !== undefined ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      {outcome !== undefined ? (
        <p className={styles.note} role="status">
          {outcomeText(outcome, t)}
        </p>
      ) : null}
    </section>
  );
}
