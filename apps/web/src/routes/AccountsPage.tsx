import { currentMonth } from '@budget/shared';
import { useState } from 'react';

import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { EmptyState } from '../components/EmptyState';
import { PageHeader } from '../components/PageHeader';
import { QueryStateNotice } from '../components/QueryStateNotice';
import { useAccounts, type AccountRead } from '../data/accounts';
import { useSummary } from '../data/transactions';
import { AccountFormModal } from '../features/accounts/AccountFormModal';
import { AccountList } from '../features/accounts/AccountList';
import { ImportUploadModal } from '../features/imports/ImportUploadModal';
import { useT } from '../i18n/context';
import { queryPhase } from '../lib/queryPhase';
import styles from './AccountsPage.module.css';

type ModalState =
  | { type: 'closed' }
  | { type: 'create' }
  | { type: 'edit'; account: AccountRead }
  // statement-import S4: the flow starts from the accounts screen because a
  // statement belongs TO an account — the modal asks which one and then hands
  // over to /imports/:id.
  | { type: 'import' };

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
      {/* PageHeader, not a hand-rolled row: its actions wrap UNDER the title on a
          narrow screen instead of overlapping it (web-qa, 375px). */}
      <PageHeader
        title={t('accounts.title')}
        actions={
          <>
            {/* Only offered when there is an account to import INTO: the modal's
                first control is the account picker, and an empty one would be a
                dead end. */}
            {accountsQuery.data && accountsQuery.data.length > 0 ? (
              <Button onClick={() => setModal({ type: 'import' })}>
                {t('accounts.importStatement')}
              </Button>
            ) : null}
            <Button variant="primary" onClick={() => setModal({ type: 'create' })}>
              {t('accounts.add')}
            </Button>
          </>
        }
      />

      {phase === 'loading' ? (
        <Card size="none" className={styles.skeletons} aria-hidden="true">
          <div className={styles.skeletonRow} />
          <div className={styles.skeletonRow} />
          <div className={styles.skeletonRow} />
        </Card>
      ) : phase === 'error' || phase === 'unreachable' ? (
        <QueryStateNotice
          phase={phase}
          message={t('accounts.loadFailed')}
          onRetry={() => {
            void accountsQuery.refetch();
          }}
        />
      ) : accountsQuery.data && accountsQuery.data.length === 0 ? (
        <EmptyState
          title={t('accounts.empty')}
          actions={
            <Button variant="primary" onClick={() => setModal({ type: 'create' })}>
              {t('accounts.add')}
            </Button>
          }
        />
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
      {modal.type === 'import' ? (
        <ImportUploadModal
          accounts={accountsQuery.data ?? []}
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
