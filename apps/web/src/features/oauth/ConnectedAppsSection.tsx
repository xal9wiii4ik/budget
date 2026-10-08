import { useMemo, useState } from 'react';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState } from '../../components/EmptyState';
import { QueryStateNotice } from '../../components/QueryStateNotice';
import { useConnectedApps, useRevokeConnectedApp, type OAuthAppRead } from '../../data/oauthApps';
import { useLang, useT } from '../../i18n/context';
import { describeOAuthError } from '../../lib/errors';
import { queryPhase } from '../../lib/queryPhase';
import { ConnectedAppRow } from './ConnectedAppRow';
import styles from './ConnectedApps.module.css';

/**
 * Settings → Connected AI apps (mcp-remote W1): the grants Claude and friends
 * hold through the remote connector, and the one way to cut them off.
 *
 * It sits BEFORE the access-tokens block on purpose: the connector is the primary
 * way to attach an AI app now, and a hand-made token is the fallback.
 *
 * No money anywhere in this section — it lists apps and dates only.
 */
export function ConnectedAppsSection() {
  const lang = useLang();
  const t = useT();
  const appsQuery = useConnectedApps();
  const phase = queryPhase(appsQuery);
  const revoke = useRevokeConnectedApp();

  const [confirming, setConfirming] = useState<OAuthAppRead | null>(null);
  const [revokeError, setRevokeError] = useState<string | undefined>(undefined);

  // The server sends `created_at desc, id`; the only thing the screen adds is
  // pushing revoked rows below the active ones, order preserved within each
  // group (the tokens block's `ordered`). Derived during render.
  const items = appsQuery.data?.items;
  const ordered = useMemo(() => {
    if (!items) return [];
    return [
      ...items.filter((app) => app.revoked_at === null),
      ...items.filter((app) => app.revoked_at !== null),
    ];
  }, [items]);

  const appLabel = (app: OAuthAppRead) => app.client_name ?? t('connectedApps.unknownApp');

  // Where to paste the connector into Claude. Read during render from the origin
  // the app is actually served from, so a QA stand and production each show their
  // own address; display-only, and deliberately a plain selectable <code> in v1
  // (a copy button would need a clipboard-failure arm of its own).
  const connectorUrl = `${window.location.origin}/mcp`;
  const connectHint = (
    <span className={styles.connect}>
      {t('connectedApps.connectSteps')} <code className={styles.code}>{connectorUrl}</code>
    </span>
  );

  const confirmRevoke = async (app: OAuthAppRead) => {
    setRevokeError(undefined);
    try {
      await revoke.mutateAsync({ id: app.id });
      setConfirming(null);
    } catch (error) {
      setRevokeError(describeOAuthError(error, lang, t).message);
    }
  };

  return (
    <section className={styles.section}>
      <h2 className={styles.title}>{t('connectedApps.heading')}</h2>
      <p className={styles.lede}>{t('connectedApps.lede')}</p>

      {phase === 'loading' ? (
        <div className={styles.skeletons} aria-hidden="true">
          <div className={styles.skeletonRow} />
          <div className={styles.skeletonRow} />
          <div className={styles.skeletonRow} />
        </div>
      ) : phase === 'error' || phase === 'unreachable' ? (
        <QueryStateNotice
          phase={phase}
          message={t('connectedApps.loadFailed')}
          onRetry={() => {
            void appsQuery.refetch();
          }}
        />
      ) : ordered.length === 0 ? (
        // An empty state that says what to do next, not "no data": the steps ARE
        // the body here, so they are not repeated above it.
        <EmptyState title={t('connectedApps.emptyTitle')} description={connectHint} />
      ) : (
        <>
          <p className={styles.hintRow}>{connectHint}</p>
          <ul className={styles.list}>
            {ordered.map((app) => (
              <ConnectedAppRow
                key={app.id}
                app={app}
                name={appLabel(app)}
                isRevokePending={revoke.isPending && confirming?.id === app.id}
                onRevoke={(target) => {
                  setRevokeError(undefined);
                  setConfirming(target);
                }}
              />
            ))}
          </ul>
        </>
      )}

      {confirming ? (
        <ConfirmDialog
          title={t('connectedApps.revokeTitle')}
          message={t('connectedApps.revokeMessage', { name: appLabel(confirming) })}
          confirmLabel={t('connectedApps.revoke')}
          pendingLabel={t('connectedApps.revoking')}
          destructive
          isPending={revoke.isPending}
          errorMessage={revokeError}
          onConfirm={() => {
            void confirmRevoke(confirming);
          }}
          onCancel={() => setConfirming(null)}
        />
      ) : null}
    </section>
  );
}
