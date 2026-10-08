import { formatTimestamp } from '@budget/shared';

import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import type { OAuthAppRead } from '../../data/oauthApps';
import { useLocale, useT } from '../../i18n/context';
import styles from './ConnectedApps.module.css';

interface ConnectedAppRowProps {
  app: OAuthAppRead;
  /** The name the section decided to show — `client_name` or the fallback. The
   *  row does not resolve it twice: the revoke dialog names the same string. */
  name: string;
  isRevokePending: boolean;
  onRevoke: (app: OAuthAppRead) => void;
}

/**
 * One connected app. A SIBLING of `features/tokens/TokenRow`, not a reuse: a
 * token's `name` is a non-null string the USER typed, while `client_name` is a
 * nullable string the APP declared about itself, the two rows want different
 * copy ("disconnect an app" vs "revoke a token"), and widening TokenRow into a
 * structural union with four label props would cost more than the handful of
 * shared CSS lines — the same call `TokenRow.module.css` already makes about
 * `Card`.
 *
 * A revoked row stays listed, dimmed and badged with WHEN, and carries no button
 * — the revocation is a fact worth seeing (the TokenRow rule). Every timestamp is
 * a server field formatted for the viewer's locale; nothing is compared to "now".
 */
export function ConnectedAppRow({ app, name, isRevokePending, onRevoke }: ConnectedAppRowProps) {
  const locale = useLocale();
  const t = useT();
  const revoked = app.revoked_at !== null;

  return (
    <li className={revoked ? `${styles.row} ${styles.revoked}` : styles.row}>
      <div className={styles.main}>
        <div className={styles.identity}>
          {/* The app's own claim about its name, rendered as TEXT. */}
          <span className={styles.name}>{name}</span>
          {/* The SAME two labels the tokens section uses, so the two sections
              can never name one mode differently. */}
          <Badge tone="accent">
            {t(app.scope === 'read' ? 'tokens.scopeRead' : 'tokens.scopeFull')}
          </Badge>
          {app.revoked_at !== null ? (
            <Badge tone="danger">
              {t('connectedApps.revokedBadge', {
                date: formatTimestamp(app.revoked_at, { locale }),
              })}
            </Badge>
          ) : null}
        </div>
        {!revoked ? (
          <Button
            size="sm"
            className={styles.revokeButton}
            onClick={() => onRevoke(app)}
            disabled={isRevokePending}
          >
            {t(isRevokePending ? 'connectedApps.revoking' : 'connectedApps.revoke')}
          </Button>
        ) : null}
      </div>
      <p className={styles.meta}>
        {t('connectedApps.connected', { date: formatTimestamp(app.created_at, { locale }) })} ·{' '}
        {app.last_used_at !== null
          ? t('connectedApps.lastUsed', {
              date: formatTimestamp(app.last_used_at, { locale }),
            })
          : t('connectedApps.neverUsed')}
      </p>
    </li>
  );
}
