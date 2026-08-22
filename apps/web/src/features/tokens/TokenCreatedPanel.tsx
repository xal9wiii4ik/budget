import { useRef, useState } from 'react';

import { useT } from '../../i18n/context';
import styles from './TokenFormModal.module.css';

interface TokenCreatedPanelProps {
  /**
   * The plaintext, one copy, held in the parent modal's state. It is passed down
   * as a prop and rendered — it is never stored, logged, put in the URL or
   * written to the Query cache anywhere in this feature.
   */
  token: string;
  name: string;
  onDone: () => void;
}

type CopyState = 'idle' | 'copied' | 'failed';

/**
 * The one and only showing of a token's plaintext.
 *
 * It replaces the form inside the SAME modal instead of opening a second one:
 * the create is already done, so a nested dialog would just be another surface
 * the user can dismiss by accident — and dismissing this one loses the string
 * for good. That is also why the hosting modal neutralizes Esc/backdrop/× while
 * this panel is up: "Done" is the only way out, and it is right under the
 * warning that says why.
 */
export function TokenCreatedPanel({ token, name, onDone }: TokenCreatedPanelProps) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [copyState, setCopyState] = useState<CopyState>('idle');

  const copy = async () => {
    // `navigator.clipboard` is undefined outside a secure context (plain http on
    // a LAN address, which is exactly how a self-hosted budget gets opened), and
    // `writeText` rejects when the permission is denied. Both land on the manual
    // path: the string is selected for the user and the copy shortcut is named.
    const clipboard = navigator.clipboard;
    if (!clipboard) {
      selectForManualCopy();
      return;
    }
    try {
      await clipboard.writeText(token);
      setCopyState('copied');
    } catch {
      selectForManualCopy();
    }
  };

  const selectForManualCopy = () => {
    setCopyState('failed');
    inputRef.current?.focus();
    inputRef.current?.select();
  };

  return (
    <div className={styles.created}>
      <p className={styles.createdIntro}>
        {t('tokenCreated.introPrefix')} <strong>{name}</strong>{' '}
        {t('tokenCreated.introSuffix')}
      </p>

      <div className={styles.tokenRow}>
        <label className={styles.srOnly} htmlFor="token-plaintext">
          {t('tokenCreated.srLabel')}
        </label>
        <input
          id="token-plaintext"
          ref={inputRef}
          className={styles.tokenValue}
          value={token}
          readOnly
          spellCheck={false}
          onFocus={(event) => event.currentTarget.select()}
        />
        <button
          type="button"
          className={styles.copyButton}
          onClick={() => {
            void copy();
          }}
        >
          {t(copyState === 'copied' ? 'tokenCreated.copied' : 'tokenCreated.copy')}
        </button>
      </div>

      <p className={styles.copyStatus} role="status">
        {copyState === 'copied' ? t('tokenCreated.copiedStatus') : null}
        {copyState === 'failed' ? t('tokenCreated.copyFailed') : null}
      </p>

      {/* Before the button on purpose: the user has to read why "Done" is
          irreversible before they can reach it. */}
      <p className={styles.warning} role="alert">
        {t('tokenCreated.warning')}
      </p>

      <div className={styles.actions}>
        <span className={styles.spacer} />
        <button type="button" className={styles.submit} onClick={onDone}>
          {t('tokenCreated.done')}
        </button>
      </div>
    </div>
  );
}
