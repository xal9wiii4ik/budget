import type { ChangeEvent } from 'react';
import type { UseFormRegisterReturn } from 'react-hook-form';

import { QueryStateNotice } from '../../components/QueryStateNotice';
import { useT } from '../../i18n/context';
import type { AccountRead } from '../../data/accounts';
import type { QueryPhase } from '../../lib/queryPhase';
import { AccountSelect, AccountsRequiredNotice } from './AccountSelect';
import { selectableAccounts } from './accountOptions';
import styles from './AccountSelect.module.css';

interface AccountFieldProps {
  id: string;
  label: string;
  hint?: string;
  registration: UseFormRegisterReturn;
  accounts: AccountRead[];
  /** The accounts query's phase — all four arms are rendered here, once. */
  phase: QueryPhase;
  onRetry: () => void;
  currentId?: string | null;
  onChange?: (event: ChangeEvent<HTMLSelectElement>) => void;
  errorMessage?: string;
}

/**
 * One labelled account picker, with every state a money form can be in:
 *
 *   loading      — a placeholder of the control's height, so the dialog does not
 *                  jump when the list lands, and NOT the "create an account
 *                  first" copy, which would be a claim about data we do not have;
 *   error /
 *   unreachable  — the shared notice with a retry (`queryPhase` 4 arms: a paused
 *                  query is not a slow one, and must never render as an eternal
 *                  skeleton);
 *   empty        — the dead end with the way out on it (there is no valid body to
 *                  submit without an account, so the host form disables Save);
 *   ready        — the picker.
 *
 * Keeping all four here is what stops each form from re-deciding them (the
 * plan-web risk note about the transaction form growing an account branch).
 */
export function AccountField({
  id,
  label,
  hint,
  registration,
  accounts,
  phase,
  onRetry,
  currentId,
  onChange,
  errorMessage,
}: AccountFieldProps) {
  const t = useT();
  const hasOptions = selectableAccounts(accounts, currentId).length > 0;

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>

      {phase === 'loading' ? (
        <div className={styles.placeholder} aria-hidden="true" />
      ) : phase === 'error' || phase === 'unreachable' ? (
        <QueryStateNotice
          phase={phase}
          message={t('accounts.loadFailed')}
          compact
          onRetry={onRetry}
        />
      ) : hasOptions ? (
        <AccountSelect
          id={id}
          registration={registration}
          accounts={accounts}
          currentId={currentId}
          onChange={onChange}
          invalid={errorMessage !== undefined}
        />
      ) : (
        <AccountsRequiredNotice />
      )}

      {hint ? <p className={styles.hint}>{hint}</p> : null}
      {errorMessage ? (
        <p className={styles.fieldError} role="alert">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
