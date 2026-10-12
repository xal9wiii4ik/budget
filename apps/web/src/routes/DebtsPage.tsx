import { todayApiDateUtc } from '@budget/shared';
import { useMemo, useState } from 'react';

import { Button } from '../components/Button';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EmptyState } from '../components/EmptyState';
import { PageHeader } from '../components/PageHeader';
import { QueryStateNotice } from '../components/QueryStateNotice';
import {
  useDebts,
  useDeleteDebt,
  useDeleteRepayment,
  type DebtRepaymentRead,
} from '../data/debts';
import { DebtFormModal } from '../features/debts/DebtFormModal';
import { DebtHistoryModal } from '../features/debts/DebtHistoryModal';
import { DebtList } from '../features/debts/DebtList';
import { DebtSummaryHeader } from '../features/debts/DebtSummaryHeader';
import { RepaymentModal } from '../features/debts/RepaymentModal';
import { useLang, useT } from '../i18n/context';
import { describeDebtError } from '../lib/errors';
import { queryPhase } from '../lib/queryPhase';
import styles from './DebtsPage.module.css';

/**
 * ONE modal at a time, by construction.
 *
 * Every variant below is a `Modal` (a ConfirmDialog is one too), and a Modal
 * mounted inside an open Modal's subtree means two document-level Esc handlers
 * and two focus traps fighting over the same Tab. So the repayment dialogs
 * REPLACE the history window rather than stacking on it, and `from` is how they
 * find their way back to it when they close.
 *
 * Every variant carries the debt's ID and NOTHING else of it. A `DebtRead` in
 * this state would be a SNAPSHOT: the window and the repayment form would keep
 * showing the remaining amount as it was when they opened, and a repayment
 * recorded from them would leave two different figures on one screen and a
 * refusal naming a number the user cannot see (defect D-1). The live row is
 * looked up by id below, out of the same cached list the screen renders, so a
 * mutation's invalidation re-renders these windows with the server's figures.
 */
type ModalState =
  | { type: 'closed' }
  | { type: 'create' }
  | { type: 'edit'; debtId: string }
  | { type: 'history'; debtId: string }
  | {
      type: 'repayment';
      debtId: string;
      /** `undefined` = record a new one; a row = correct a recorded one. */
      repayment?: DebtRepaymentRead;
      from: 'row' | 'history';
    }
  | { type: 'deleteDebt'; debtId: string }
  | { type: 'deleteRepayment'; debtId: string; repayment: DebtRepaymentRead; from: 'history' };

/** Which debt an open modal is about — `undefined` for the two that are about none. */
function modalDebtIdOf(modal: ModalState): string | undefined {
  return modal.type === 'closed' || modal.type === 'create' ? undefined : modal.debtId;
}

/**
 * The debts screen: who owes me, and whom do I owe (task.md).
 *
 * Every figure here is a SERVER field. The two groups split by `direction`, the
 * settled ones sit in a collapsed section, and the header shows the two sides of
 * the `summary` the list response carries — converted to the base currency by the
 * server, with the debts it could not convert COUNTED rather than quietly left
 * out. This screen sums nothing, converts nothing and subtracts nothing: there is
 * no "net position" line, because across currencies that is not a number a
 * browser may invent.
 *
 * A debt movement is an ordinary operation on an ordinary account (architecture
 * representation (A)) — it changes balances and appears in /transactions, but is
 * excluded from every statistic and budget server-side, exactly like a transfer.
 * The lede says so, because "my money disappeared" is the question this screen
 * exists to answer.
 */
export function DebtsPage() {
  const lang = useLang();
  const t = useT();
  const debtsQuery = useDebts();
  const phase = queryPhase(debtsQuery);
  const [modal, setModal] = useState<ModalState>({ type: 'closed' });

  const deleteDebt = useDeleteDebt();
  const deleteRepayment = useDeleteRepayment();
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined);

  const debts = useMemo(() => debtsQuery.data?.items ?? [], [debtsQuery.data]);
  // UTC, like the deadline widget's own "today": the SERVER decides `status` and
  // the reminder window in UTC, and a local-midnight compare disagrees with it
  // for hours in any offset zone. A stable string within a day, so it is a real
  // value to pass down rather than a per-render surprise.
  const today = todayApiDateUtc();

  // The LIVE row behind whichever modal is open, derived during render from the
  // cached list — never stored. `undefined` means the debt is gone (deleted
  // here, or in another tab, and the refetch has landed): there is no figure to
  // draw, so the window simply does not render, which is what "closed" means to
  // the user and to the DOM. Derived rather than reconciled in an effect, so no
  // render ever shows a dead row.
  const modalDebtId = modalDebtIdOf(modal);
  const activeDebt = useMemo(
    () => (modalDebtId === undefined ? undefined : debts.find((row) => row.id === modalDebtId)),
    [debts, modalDebtId],
  );

  const closeModal = () => {
    setDeleteError(undefined);
    setModal({ type: 'closed' });
  };

  // Where a repayment dialog returns to (see ModalState): the window it was
  // opened from, so correcting one repayment does not cost the user the list.
  const backFrom = (from: 'row' | 'history', debtId: string) => () => {
    setDeleteError(undefined);
    setModal(from === 'history' ? { type: 'history', debtId } : { type: 'closed' });
  };

  const confirmDeleteDebt = async (debtId: string) => {
    setDeleteError(undefined);
    try {
      await deleteDebt.mutateAsync(debtId);
      closeModal();
    } catch (error) {
      setDeleteError(describeDebtError(error, lang, t).message);
    }
  };

  const confirmDeleteRepayment = async (debtId: string, repayment: DebtRepaymentRead) => {
    setDeleteError(undefined);
    try {
      await deleteRepayment.mutateAsync({ debtId, repaymentId: repayment.id });
      // Back to the history window: the row it was deleted from is the place the
      // user is reading, and the detail read has just been invalidated.
      setModal({ type: 'history', debtId });
    } catch (error) {
      setDeleteError(describeDebtError(error, lang, t).message);
    }
  };

  return (
    <section className={styles.page}>
      <PageHeader
        className={styles.header}
        title={t('debts.title')}
        actions={
          <Button variant="primary" onClick={() => setModal({ type: 'create' })}>
            {t('debts.add')}
          </Button>
        }
      />

      <p className={styles.lede}>{t('debts.lede')}</p>

      {phase === 'loading' ? (
        <>
          <div className={styles.summary}>
            <DebtSummaryHeader summary={undefined} />
          </div>
          {/* Fixed-height placeholders, so the list does not jump when it lands. */}
          <div className={styles.skeletons} aria-hidden="true">
            <div className={styles.skeletonRow} />
            <div className={styles.skeletonRow} />
          </div>
        </>
      ) : phase === 'error' || phase === 'unreachable' ? (
        /* No summary card at all on a failed read: a figure we do not have must
           not be drawn as zero. */
        <QueryStateNotice
          phase={phase}
          message={t('debts.loadFailed')}
          onRetry={() => {
            void debtsQuery.refetch();
          }}
        />
      ) : debts.length === 0 ? (
        /* Nothing recorded yet: the summary card would be two zeros next to
           "no debts yet" — server fields, but a figure about nothing is noise
           where the screen should only say what to do next. */
        <EmptyState
          title={t('debts.empty')}
          description={t('debts.emptyCta')}
          actions={
            <Button variant="primary" onClick={() => setModal({ type: 'create' })}>
              {t('debts.add')}
            </Button>
          }
        />
      ) : (
        <>
          <div className={styles.summary}>
            <DebtSummaryHeader summary={debtsQuery.data?.summary} />
          </div>

          <DebtList
            debts={debts}
            today={today}
            onEdit={(debt) => setModal({ type: 'edit', debtId: debt.id })}
            onRecordRepayment={(debt) =>
              setModal({ type: 'repayment', debtId: debt.id, from: 'row' })
            }
            onHistory={(debt) => setModal({ type: 'history', debtId: debt.id })}
            onDelete={(debt) => {
              setDeleteError(undefined);
              setModal({ type: 'deleteDebt', debtId: debt.id });
            }}
          />
        </>
      )}

      {modal.type === 'create' ? <DebtFormModal onClose={closeModal} /> : null}

      {/* One guard for every debt-bearing variant: no live row, no window. */}
      {activeDebt === undefined ? null : (
        <>
          {modal.type === 'edit' ? (
            <DebtFormModal key={activeDebt.id} debt={activeDebt} onClose={closeModal} />
          ) : null}

          {modal.type === 'history' ? (
            <DebtHistoryModal
              key={activeDebt.id}
              debt={activeDebt}
              onRecordRepayment={() =>
                setModal({ type: 'repayment', debtId: activeDebt.id, from: 'history' })
              }
              onEditRepayment={(repayment) =>
                setModal({ type: 'repayment', debtId: activeDebt.id, repayment, from: 'history' })
              }
              onDeleteRepayment={(repayment) => {
                setDeleteError(undefined);
                setModal({
                  type: 'deleteRepayment',
                  debtId: activeDebt.id,
                  repayment,
                  from: 'history',
                });
              }}
              onClose={closeModal}
            />
          ) : null}

          {modal.type === 'repayment' ? (
            <RepaymentModal
              key={modal.repayment?.id ?? `new:${activeDebt.id}`}
              debt={activeDebt}
              repayment={modal.repayment}
              onClose={backFrom(modal.from, activeDebt.id)}
            />
          ) : null}

          {modal.type === 'deleteDebt' ? (
            <ConfirmDialog
              title={t('debts.deleteTitle')}
              // Says what the cascade does out loud: the movements go with the
              // debt and the balances revert in the same statement.
              message={t('debts.deleteMessage', { name: activeDebt.counterparty })}
              confirmLabel={t('common.delete')}
              pendingLabel={t('common.deleting')}
              destructive
              isPending={deleteDebt.isPending}
              errorMessage={deleteError}
              onConfirm={() => {
                void confirmDeleteDebt(activeDebt.id);
              }}
              onCancel={closeModal}
            />
          ) : null}

          {modal.type === 'deleteRepayment' ? (
            <ConfirmDialog
              title={t('repayment.deleteTitle')}
              message={t('repayment.deleteMessage')}
              confirmLabel={t('common.delete')}
              pendingLabel={t('common.deleting')}
              destructive
              isPending={deleteRepayment.isPending}
              errorMessage={deleteError}
              onConfirm={() => {
                void confirmDeleteRepayment(activeDebt.id, modal.repayment);
              }}
              onCancel={() => {
                setDeleteError(undefined);
                setModal({ type: 'history', debtId: activeDebt.id });
              }}
            />
          ) : null}
        </>
      )}
    </section>
  );
}
