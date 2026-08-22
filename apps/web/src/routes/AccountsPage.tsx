import { currentMonth } from '@budget/shared';
import { useState } from 'react';

import { QueryStateNotice } from '../components/QueryStateNotice';
import { useAccounts, type AccountRead } from '../data/accounts';
import { useSummary } from '../data/transactions';
import { AccountFormModal } from '../features/accounts/AccountFormModal';
import { AccountList } from '../features/accounts/AccountList';
import { useT } from '../i18n/context';
import { queryPhase } from '../lib/queryPhase';
import styles from './AccountsPage.module.css';

type ModalState =
  | { type: 'closed' }
  | { type: 'create' }
  | { type: 'edit'; account: AccountRead };

/**
 * The accounts screen: what money lives where, and the only place accounts are
 * created, renamed and archived.
 *
 * Every `balance_minor` comes from the server (architecture §2) — this screen
 * sums nothing, converts nothing and shows no "total across accounts", because
 * such a total would need an exchange rate the balances do not carry.
 */
export function AccountsPage() {
  const t = useT();
  const accountsQuery = useAccounts();
  const phase = queryPhase(accountsQuery);
  const [modal, setModal] = useState<ModalState>({ type: 'closed' });

  // The profile base currency, only as the DEFAULT pick for a new account (the
  // shipped TransactionFormModal / TemplateFormModal pattern: there is no
  // /profile endpoint, the month summary is where the base currency lives, and
  // this month's summary is usually already in cache). It never decodes anything
  // here, so the form opens with the picker's own first option while it loads.
  const summary = useSummary(currentMonth());

  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>{t('accounts.title')}</h1>
        <button
          type="button"
          className={styles.addButton}
          onClick={() => setModal({ type: 'create' })}
        >
          {t('accounts.add')}
        </button>
      </header>

      {phase === 'loading' ? (
        <div className={styles.skeletons} aria-hidden="true">
          <div className={styles.skeletonRow} />
          <div className={styles.skeletonRow} />
          <div className={styles.skeletonRow} />
        </div>
      ) : phase === 'error' || phase === 'unreachable' ? (
        <QueryStateNotice
          phase={phase}
          message={t('accounts.loadFailed')}
          onRetry={() => {
            void accountsQuery.refetch();
          }}
        />
      ) : accountsQuery.data && accountsQuery.data.length === 0 ? (
        <div className={styles.empty}>
          <p>{t('accounts.empty')}</p>
          <button
            type="button"
            className={styles.emptyAdd}
            onClick={() => setModal({ type: 'create' })}
          >
            {t('accounts.add')}
          </button>
        </div>
      ) : (
        <AccountList
          accounts={accountsQuery.data ?? []}
          onEdit={(account) => setModal({ type: 'edit', account })}
        />
      )}

      {modal.type === 'create' ? (
        <AccountFormModal
          defaultCurrency={summary.data?.currency}
          onClose={() => setModal({ type: 'closed' })}
        />
      ) : null}
      {modal.type === 'edit' ? (
        <AccountFormModal
          key={modal.account.id}
          account={modal.account}
          defaultCurrency={modal.account.currency}
          onClose={() => setModal({ type: 'closed' })}
        />
      ) : null}
    </section>
  );
}
