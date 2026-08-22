import type { ChangeEvent } from 'react';
import type { UseFormRegisterReturn } from 'react-hook-form';
import { Link } from 'react-router';

import type { AccountRead } from '../../data/accounts';
import { useT } from '../../i18n/context';
import { selectableAccounts } from './accountOptions';
import styles from './AccountSelect.module.css';

interface AccountSelectProps {
  id: string;
  /** `register('account_id')` (or `counter_account_id` on the transfer form). */
  registration: UseFormRegisterReturn;
  accounts: AccountRead[];
  /**
   * The account currently stored on the row being edited. It stays selectable
   * even when archived, and its option is marked "(archived)".
   */
  currentId?: string | null;
  /** Runs AFTER RHF has recorded the new value (the CurrencySelect convention). */
  onChange?: (event: ChangeEvent<HTMLSelectElement>) => void;
  disabled?: boolean;
  invalid?: boolean;
}

/**
 * The one account picker, shared by the transaction, transfer and template forms.
 *
 * It shows the account's CURRENCY next to its name because on this app the two
 * are inseparable: the currency of everything recorded on an account is the
 * account's (architecture §4), so picking the account IS picking the currency.
 * The list has no "none" option — `account_id` is required server-side, and the
 * empty value exists only as the unpicked state the schema rejects.
 */
export function AccountSelect({
  id,
  registration,
  accounts,
  currentId,
  onChange,
  disabled,
  invalid,
}: AccountSelectProps) {
  const t = useT();
  const options = selectableAccounts(accounts, currentId);

  return (
    <select
      {...registration}
      id={id}
      className={invalid ? `${styles.select} ${styles.invalid}` : styles.select}
      disabled={disabled}
      aria-invalid={invalid ? true : undefined}
      onChange={(event) => {
        void registration.onChange(event);
        onChange?.(event);
      }}
    >
      <option value="">{t('accounts.choose')}</option>
      {options.map((account) => (
        <option key={account.id} value={account.id}>
          {account.name} · {account.currency}
          {account.archived ? ` ${t('common.archivedParens')}` : ''}
        </option>
      ))}
    </select>
  );
}

/**
 * What a money form shows INSTEAD of the picker when there is no account to pick.
 *
 * Every transaction is recorded on an account, so this is not an empty select —
 * it is a dead end with the way out on it. The hosting form disables its submit
 * (there is nothing valid to send) rather than letting the user type an amount
 * that cannot be saved.
 */
export function AccountsRequiredNotice() {
  const t = useT();
  return (
    <p className={styles.required} role="status">
      {t('accounts.required')}{' '}
      <Link to="/accounts" className={styles.requiredLink}>
        {t('accounts.goToAccounts')}
      </Link>
    </p>
  );
}
