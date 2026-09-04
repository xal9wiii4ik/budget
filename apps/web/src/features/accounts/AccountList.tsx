import { Card } from '../../components/Card';
import type { AccountRead } from '../../data/accounts';
import { useT } from '../../i18n/context';
import { AccountRow } from './AccountRow';
import styles from './AccountList.module.css';

interface AccountListProps {
  accounts: AccountRead[];
  onEdit: (account: AccountRead) => void;
}

/**
 * The accounts screen's list: live accounts first, archived ones last and muted.
 *
 * Two groups rather than a flat list with tags: an archived account is not part
 * of "what I have" — it is history that must stay reachable (its balance still
 * explains past rows), which is exactly what a separate, quieter section says.
 */
export function AccountList({ accounts, onEdit }: AccountListProps) {
  const t = useT();
  const live = accounts.filter((account) => !account.archived);
  const archived = accounts.filter((account) => account.archived);

  return (
    <div className={styles.groups}>
      <Card size="none">
        <ul className={styles.list}>
          {live.map((account) => (
            <li key={account.id}>
              <AccountRow account={account} onEdit={onEdit} />
            </li>
          ))}
        </ul>
      </Card>

      {archived.length > 0 ? (
        <section className={styles.group}>
          <h2 className={styles.groupTitle}>{t('accounts.archivedGroup')}</h2>
          <Card size="none">
            <ul className={styles.list}>
              {archived.map((account) => (
                <li key={account.id}>
                  <AccountRow account={account} onEdit={onEdit} />
                </li>
              ))}
            </ul>
          </Card>
        </section>
      ) : null}
    </div>
  );
}
