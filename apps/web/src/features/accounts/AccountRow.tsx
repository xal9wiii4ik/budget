import { formatMoney } from '@budget/shared';

import type { AccountRead } from '../../data/accounts';
import { useLocale, useT } from '../../i18n/context';
import styles from './AccountList.module.css';

interface AccountRowProps {
  account: AccountRead;
  onEdit: (account: AccountRead) => void;
}

/**
 * One account row: name, type, and the balance.
 *
 * `balance_minor` is COMPUTED BY THE SERVER (architecture §2) and rendered with
 * the account's OWN currency — nothing here adds a starting balance to a sum of
 * transactions, and nothing converts between currencies. A negative balance (a
 * card in the minus is legitimate) is formatted by the shared helper, so its sign
 * follows the user's locale instead of a hand-glued "-".
 */
export function AccountRow({ account, onEdit }: AccountRowProps) {
  const locale = useLocale();
  const t = useT();
  const className = account.archived ? `${styles.row} ${styles.archived}` : styles.row;

  return (
    <button type="button" className={className} onClick={() => onEdit(account)}>
      <span className={styles.icon} aria-hidden="true">
        {account.type === 'cash' ? '💵' : '💳'}
      </span>
      <span className={styles.details}>
        <span className={styles.name}>{account.name}</span>
        <span className={styles.meta}>
          {account.type === 'cash' ? t('accounts.typeCash') : t('accounts.typeCard')} ·{' '}
          {account.currency}
          {account.archived ? ` · ${t('common.archivedTag')}` : ''}
        </span>
      </span>
      <span
        className={
          account.balance_minor < 0
            ? `${styles.balance} ${styles.negative} tnum`
            : `${styles.balance} tnum`
        }
      >
        {formatMoney(account.balance_minor, account.currency, { locale })}
      </span>
    </button>
  );
}
