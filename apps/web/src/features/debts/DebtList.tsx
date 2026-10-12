import type { DebtRead } from '../../data/debts';
import { useT } from '../../i18n/context';
import { DebtRow } from './DebtRow';
import { groupDebts } from './debtGroups';
import styles from './DebtList.module.css';

interface DebtListProps {
  debts: DebtRead[];
  /** `todayApiDateUtc()` from the screen — the overdue compare (debtGroups). */
  today: string;
  onEdit: (debt: DebtRead) => void;
  onRecordRepayment: (debt: DebtRead) => void;
  onHistory: (debt: DebtRead) => void;
  onDelete: (debt: DebtRead) => void;
}

/**
 * The two open groups — "Мне должны" and "Я должен" — and the settled ones in a
 * collapsed section below (task.md §"Как должно работать").
 *
 * The split is done here rather than server-side because `GET /debts` is ONE
 * status-inclusive response by design (there is no `?status=` to pass): one cache
 * entry, which the deadline widget and the row badge read too. The grouping and
 * the ordering live in the pure, tested `groupDebts`; this component only renders
 * them.
 */
export function DebtList({
  debts,
  today,
  onEdit,
  onRecordRepayment,
  onHistory,
  onDelete,
}: DebtListProps) {
  const t = useT();
  const groups = groupDebts(debts);

  const rows = (items: DebtRead[]) => (
    <ul className={styles.list}>
      {items.map((debt) => (
        <li key={debt.id}>
          <DebtRow
            debt={debt}
            today={today}
            onEdit={onEdit}
            onRecordRepayment={onRecordRepayment}
            onHistory={onHistory}
            onDelete={onDelete}
          />
        </li>
      ))}
    </ul>
  );

  const openGroup = (titleKey: 'debts.groupLent' | 'debts.groupBorrowed', items: DebtRead[]) =>
    items.length === 0 ? null : (
      <section className={styles.group}>
        <h2 className={styles.groupTitle}>{t(titleKey)}</h2>
        {rows(items)}
      </section>
    );

  const nothingOpen = groups.lent.length === 0 && groups.borrowed.length === 0;

  return (
    <div className={styles.groups}>
      {openGroup('debts.groupLent', groups.lent)}
      {openGroup('debts.groupBorrowed', groups.borrowed)}

      {/* Said out loud rather than left as a blank space above the closed
          section: "no groups at all" would read as a failed load. */}
      {nothingOpen && groups.closed.length > 0 ? (
        <p className={styles.meta}>{t('debts.nothingOpen')}</p>
      ) : null}

      {groups.closed.length > 0 ? (
        /* Collapsed by default: settled debts are history that must stay
           readable (their movements still explain past rows) without pushing the
           live ones off the screen. A native <details> — keyboard and screen
           reader complete, no state of ours. */
        <details className={styles.closed}>
          <summary>{t('debts.closedGroup', { count: groups.closed.length })}</summary>
          <div className={styles.closedBody}>{rows(groups.closed)}</div>
        </details>
      ) : null}
    </div>
  );
}
