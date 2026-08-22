import { formatTimestamp } from '@budget/shared';

import type { TokenRead } from '../../data/tokens';
import { useLocale, useT } from '../../i18n/context';
import styles from './TokenRow.module.css';

interface TokenRowProps {
  token: TokenRead;
  isRevokePending: boolean;
  onRevoke: (token: TokenRead) => void;
}

// The two scopes in the same plain words the create form uses — a badge that
// said "read"/"full" would make the user go back to the form to remember what
// they granted (copy: `tokens.scopeRead` / `tokens.scopeFull`).

/**
 * One token. A revoked row stays on the list, dimmed and badged with WHEN it was
 * revoked, and carries no Revoke button — the revocation is a fact worth seeing,
 * and hiding it would make `revoked_at` a field nothing ever renders.
 *
 * Every timestamp here is a server field formatted for the viewer's locale;
 * nothing is computed, compared to "now", or turned into "3 days ago".
 */
export function TokenRow({ token, isRevokePending, onRevoke }: TokenRowProps) {
  const locale = useLocale();
  const t = useT();
  const revoked = token.revoked_at !== null;

  return (
    <li className={revoked ? `${styles.row} ${styles.revoked}` : styles.row}>
      <div className={styles.main}>
        <div className={styles.identity}>
          <span className={styles.name}>{token.name}</span>
          <span className={styles.badge}>
            {t(token.scope === 'read' ? 'tokens.scopeRead' : 'tokens.scopeFull')}
          </span>
          {token.revoked_at !== null ? (
            <span className={`${styles.badge} ${styles.badgeRevoked}`}>
              {t('tokens.revokedBadge', {
                date: formatTimestamp(token.revoked_at, { locale }),
              })}
            </span>
          ) : null}
        </div>
        {!revoked ? (
          <button
            type="button"
            className={styles.revokeButton}
            onClick={() => onRevoke(token)}
            disabled={isRevokePending}
          >
            {t(isRevokePending ? 'tokens.revoking' : 'tokens.revoke')}
          </button>
        ) : null}
      </div>
      <p className={styles.meta}>
        {t('tokens.created', { date: formatTimestamp(token.created_at, { locale }) })} ·{' '}
        {token.last_used_at !== null
          ? t('tokens.lastUsed', {
              date: formatTimestamp(token.last_used_at, { locale }),
            })
          : t('tokens.neverUsed')}
      </p>
    </li>
  );
}
