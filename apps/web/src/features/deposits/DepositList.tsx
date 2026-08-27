import type { DepositRead } from '../../data/deposits';
import { useT } from '../../i18n/context';
import { DepositRow } from './DepositRow';
import styles from './DepositList.module.css';

interface DepositListProps {
  deposits: DepositRead[];
  onEdit: (deposit: DepositRead) => void;
  onTopUp: (deposit: DepositRead) => void;
  onWithdraw: (deposit: DepositRead) => void;
  onEditAccrued: (deposit: DepositRead) => void;
}

/**
 * Open deposits first, closed ones last and muted — the AccountList shape, for
 * the same reason: a closed deposit is not part of "what I have put aside", it
 * is history that must stay readable (its balance and its transfers still
 * explain past rows), and a separate quieter section says exactly that.
 *
 * The split is done here rather than server-side because `GET /deposits` is one
 * archive-inclusive response by design (there is no `include_archived` flag to
 * pass) — the single cache entry the views dim themselves.
 */
export function DepositList({
  deposits,
  onEdit,
  onTopUp,
  onWithdraw,
  onEditAccrued,
}: DepositListProps) {
  const t = useT();
  const live = deposits.filter((deposit) => !deposit.archived);
  const archived = deposits.filter((deposit) => deposit.archived);

  const rows = (items: DepositRead[]) => (
    <ul className={styles.list}>
      {items.map((deposit) => (
        <li key={deposit.id}>
          <DepositRow
            deposit={deposit}
            onEdit={onEdit}
            onTopUp={onTopUp}
            onWithdraw={onWithdraw}
            onEditAccrued={onEditAccrued}
          />
        </li>
      ))}
    </ul>
  );

  return (
    <div className={styles.groups}>
      {rows(live)}
      {archived.length > 0 ? (
        <section className={styles.group}>
          <h2 className={styles.groupTitle}>{t('deposits.archivedGroup')}</h2>
          {rows(archived)}
        </section>
      ) : null}
    </div>
  );
}
