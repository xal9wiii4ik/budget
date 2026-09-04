import { Select } from '../../components/Field';
import { useT } from '../../i18n/context';
import type { QueryPhase } from '../../lib/queryPhase';
import type { NamedAccount } from './accountOptions';
import styles from './AccountFilter.module.css';

interface AccountFilterProps {
  /** The account currently filtered on, or null for "all accounts". */
  value: string | null;
  /**
   * Accounts AND deposit ledgers (deposits W1) — this is a READING control, not
   * a money picker: the "History" link on a deposit filters by its ledger
   * account, and without that row here the filter would label the user's own
   * deposit history "unavailable". Operation forms keep taking `AccountRead[]`,
   * so no deposit can be picked to spend from.
   */
  accounts: NamedAccount[];
  /** The accounts query's phase — this control renders its own four arms. */
  phase: QueryPhase;
  onChange: (accountId: string | null) => void;
}

/**
 * The /transactions account filter (W2). NOT a form control: it edits a URL
 * parameter, so it is a plain controlled <select> rather than an RHF field.
 *
 * DEPOSIT ledgers are listed too, tagged as such: a deposit's history is read
 * through this filter, and a row the list does not know renders as "unavailable".
 *
 * ARCHIVED accounts are listed: an archive hides an account from NEW operations,
 * it does not erase the history you may want to read. And an id that is not in
 * the list (an account archived away in another tab, a hand-typed `?account=`)
 * gets a placeholder option of its own — a <select> whose value matches no option
 * silently displays the first one, which would claim the list is filtered by an
 * account it is not.
 *
 * Loading renders a fixed-size placeholder (no toolbar jank), and an errored or
 * unreachable accounts query renders NOTHING here: the list below already carries
 * that story, and an active filter stays clearable from its own chip.
 */
export function AccountFilter({ value, accounts, phase, onChange }: AccountFilterProps) {
  const t = useT();
  if (phase === 'loading') {
    return <div className={styles.placeholder} aria-hidden="true" />;
  }
  if (phase !== 'ready' || accounts.length === 0) return null;

  const missing = value !== null && !accounts.some((account) => account.id === value);

  return (
    <Select
      className={styles.select}
      aria-label={t('accounts.filterLabel')}
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
    >
      <option value="">{t('accounts.all')}</option>
      {accounts.map((account) => (
        <option key={account.id} value={account.id}>
          {account.name} · {account.currency}
          {account.kind === 'deposit' ? ` ${t('accounts.depositTag')}` : ''}
          {account.archived ? ` ${t('common.archivedParens')}` : ''}
        </option>
      ))}
      {missing ? <option value={value}>{t('accounts.unavailable')}</option> : null}
    </Select>
  );
}
