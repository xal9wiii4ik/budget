import { currentMonth } from '@budget/shared';
import { useState } from 'react';

import { QueryStateNotice } from '../components/QueryStateNotice';
import { useDeposits, type DepositRead } from '../data/deposits';
import { useSummary } from '../data/transactions';
import { AccruedEditModal } from '../features/deposits/AccruedEditModal';
import { DepositFormModal } from '../features/deposits/DepositFormModal';
import { DepositList } from '../features/deposits/DepositList';
import { TransferFormModal } from '../features/transfers/TransferFormModal';
import { useT } from '../i18n/context';
import { queryPhase } from '../lib/queryPhase';
import styles from './DepositsPage.module.css';

type ModalState =
  | { type: 'closed' }
  | { type: 'create' }
  | { type: 'edit'; deposit: DepositRead }
  // The manual interest anchor — its own small dialog, not a field on the form
  // above: it writes one column, it is the only money the user may type on a
  // deposit, and it has a reset of its own.
  | { type: 'accrued'; deposit: DepositRead }
  // Money moves through the ORDINARY transfer form with the deposit side fixed
  // (architecture: a transfer is the one mechanism, and there is no second one).
  // 'target' = the deposit receives (top up), 'source' = it pays out (withdraw).
  | { type: 'transfer'; deposit: DepositRead; side: 'source' | 'target' };

/**
 * The deposits screen: money that exists but is NOT available (task.md §3).
 *
 * It is a separate screen for exactly that reason. A deposit's ledger account is
 * hidden from `GET /accounts` server-side, so this money is absent from the
 * account list, from every operation form's picker and from every total — and
 * the lede says so out loud, because "where did my money go?" is the question
 * this separation would otherwise raise.
 *
 * Every figure comes from the server. This screen sums nothing (not even a
 * deposit's own body and its interest), converts nothing, and shows no "total
 * across deposits" — such a total would need an exchange rate none of these
 * figures carry.
 */
export function DepositsPage() {
  const t = useT();
  const depositsQuery = useDeposits();
  const phase = queryPhase(depositsQuery);
  const [modal, setModal] = useState<ModalState>({ type: 'closed' });

  // The profile base currency, only as the DEFAULT pick for a new deposit (the
  // AccountsPage pattern: there is no cheaper place the base currency lives, and
  // this month's summary is usually already in cache). It decodes nothing here,
  // so the form opens on the picker's first option while it loads.
  const summary = useSummary(currentMonth());

  const deposits = depositsQuery.data ?? [];

  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>{t('deposits.title')}</h1>
        <button
          type="button"
          className={styles.addButton}
          onClick={() => setModal({ type: 'create' })}
        >
          {t('deposits.add')}
        </button>
      </header>

      <p className={styles.lede}>{t('deposits.lede')}</p>

      {phase === 'loading' ? (
        // Fixed-height placeholders, so the list does not jump when it lands.
        <div className={styles.skeletons} aria-hidden="true">
          <div className={styles.skeletonRow} />
          <div className={styles.skeletonRow} />
          <div className={styles.skeletonRow} />
        </div>
      ) : phase === 'error' || phase === 'unreachable' ? (
        <QueryStateNotice
          phase={phase}
          message={t('deposits.loadFailed')}
          onRetry={() => {
            void depositsQuery.refetch();
          }}
        />
      ) : deposits.length === 0 ? (
        <div className={styles.empty}>
          <p>{t('deposits.empty')}</p>
          <button
            type="button"
            className={styles.emptyAdd}
            onClick={() => setModal({ type: 'create' })}
          >
            {t('deposits.add')}
          </button>
        </div>
      ) : (
        <DepositList
          deposits={deposits}
          onEdit={(deposit) => setModal({ type: 'edit', deposit })}
          onTopUp={(deposit) => setModal({ type: 'transfer', deposit, side: 'target' })}
          onWithdraw={(deposit) => setModal({ type: 'transfer', deposit, side: 'source' })}
          onEditAccrued={(deposit) => setModal({ type: 'accrued', deposit })}
        />
      )}

      {modal.type === 'create' ? (
        <DepositFormModal
          defaultCurrency={summary.data?.currency}
          onClose={() => setModal({ type: 'closed' })}
        />
      ) : null}
      {modal.type === 'edit' ? (
        <DepositFormModal
          key={modal.deposit.id}
          deposit={modal.deposit}
          defaultCurrency={modal.deposit.currency}
          onClose={() => setModal({ type: 'closed' })}
        />
      ) : null}
      {modal.type === 'accrued' ? (
        <AccruedEditModal
          key={modal.deposit.id}
          deposit={modal.deposit}
          onClose={() => setModal({ type: 'closed' })}
        />
      ) : null}
      {modal.type === 'transfer' ? (
        <TransferFormModal
          key={`${modal.deposit.id}:${modal.side}`}
          // The LEDGER account id — that is what a transfer stores; the deposit's
          // own id means nothing to /transactions.
          prefill={{ side: modal.side, accountId: modal.deposit.account_id }}
          onClose={() => setModal({ type: 'closed' })}
        />
      ) : null}
    </section>
  );
}
