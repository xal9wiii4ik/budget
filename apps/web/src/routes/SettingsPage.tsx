import { useMemo, useState } from 'react';

import { ConfirmDialog } from '../components/ConfirmDialog';
import { QueryStateNotice } from '../components/QueryStateNotice';
import { useRevokeToken, useTokens, type TokenRead } from '../data/tokens';
import { TokenFormModal } from '../features/tokens/TokenFormModal';
import { TokenRow } from '../features/tokens/TokenRow';
import { describeTokenError } from '../lib/errors';
import { queryPhase } from '../lib/queryPhase';
import styles from './SettingsPage.module.css';

type ModalState =
  | { type: 'closed' }
  | { type: 'create' }
  | { type: 'revoke'; token: TokenRead };

/**
 * Settings — today it is exactly one thing: the personal access tokens that let
 * an MCP client into this account.
 *
 * The screen owns no server state of its own: the list is the Query cache, and
 * the only value that lives outside it (a new token's plaintext) never leaves
 * the create modal.
 */
export function SettingsPage() {
  const tokensQuery = useTokens();
  const phase = queryPhase(tokensQuery);
  const revokeToken = useRevokeToken();

  const [modal, setModal] = useState<ModalState>({ type: 'closed' });
  const [revokeError, setRevokeError] = useState<string | undefined>(undefined);

  // The server sends `created_at desc, id`; the only thing the screen adds is
  // pushing revoked tokens below the active ones, order preserved within each
  // group. Derived during render — nothing is stored.
  const items = tokensQuery.data?.items;
  const ordered = useMemo(() => {
    if (!items) return [];
    return [
      ...items.filter((token) => token.revoked_at === null),
      ...items.filter((token) => token.revoked_at !== null),
    ];
  }, [items]);

  const confirmRevoke = async (token: TokenRead) => {
    setRevokeError(undefined);
    try {
      await revokeToken.mutateAsync({ id: token.id });
      setModal({ type: 'closed' });
    } catch (error) {
      setRevokeError(describeTokenError(error).message);
    }
  };

  return (
    <section className={styles.page}>
      <h1 className={styles.title}>Settings</h1>

      <section>
        <header className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Access tokens</h2>
          <button
            type="button"
            className={styles.addButton}
            onClick={() => setModal({ type: 'create' })}
          >
            New token
          </button>
        </header>

        <p className={styles.lede}>
          A token lets an MCP client — Claude Desktop or Claude Code — work with this
          budget on your behalf. You choose what each token may do, and you can revoke
          it at any time.
        </p>

        {phase === 'loading' ? (
          <div className={styles.skeletons} aria-hidden="true">
            <div className={styles.skeletonRow} />
            <div className={styles.skeletonRow} />
            <div className={styles.skeletonRow} />
          </div>
        ) : phase === 'error' || phase === 'unreachable' ? (
          <QueryStateNotice
            phase={phase}
            message="Couldn't load your access tokens."
            onRetry={() => {
              void tokensQuery.refetch();
            }}
          />
        ) : ordered.length === 0 ? (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>No access tokens yet.</p>
            <p className={styles.emptyBody}>
              Create one to connect Claude Desktop or Claude Code to this budget. The
              token string is shown once, right after you create it.
            </p>
            <button
              type="button"
              className={styles.addButton}
              onClick={() => setModal({ type: 'create' })}
            >
              New token
            </button>
          </div>
        ) : (
          <ul className={styles.list}>
            {ordered.map((token) => (
              <TokenRow
                key={token.id}
                token={token}
                isRevokePending={
                  revokeToken.isPending &&
                  modal.type === 'revoke' &&
                  modal.token.id === token.id
                }
                onRevoke={(target) => {
                  setRevokeError(undefined);
                  setModal({ type: 'revoke', token: target });
                }}
              />
            ))}
          </ul>
        )}
      </section>

      {modal.type === 'create' ? (
        <TokenFormModal onClose={() => setModal({ type: 'closed' })} />
      ) : null}
      {modal.type === 'revoke' ? (
        <ConfirmDialog
          title="Revoke token"
          message={`Revoke "${modal.token.name}"? Anything using this token stops working immediately, and the token cannot be restored.`}
          confirmLabel="Revoke"
          pendingLabel="Revoking…"
          destructive
          isPending={revokeToken.isPending}
          errorMessage={revokeError}
          onConfirm={() => {
            void confirmRevoke(modal.token);
          }}
          onCancel={() => setModal({ type: 'closed' })}
        />
      ) : null}
    </section>
  );
}
