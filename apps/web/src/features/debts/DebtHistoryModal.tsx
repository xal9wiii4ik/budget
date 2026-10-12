import { formatApiDate, formatMoney } from '@budget/shared';

import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { QueryStateNotice } from '../../components/QueryStateNotice';
import { useDebt, type DebtRead, type DebtRepaymentRead } from '../../data/debts';
import { useT, useLocale } from '../../i18n/context';
import { queryPhase } from '../../lib/queryPhase';
import styles from './DebtHistoryModal.module.css';

interface DebtHistoryModalProps {
  /**
   * The LIVE row out of the cached list, looked up by id by the caller — never a
   * snapshot taken when this window opened. Every figure in the lede is read
   * from it on each render, so recording, correcting or deleting a repayment
   * (all of which invalidate the list) re-renders them with the server's own
   * remaining amount instead of the one that was true a moment ago.
   */
  debt: DebtRead;
  onRecordRepayment: () => void;
  onEditRepayment: (repayment: DebtRepaymentRead) => void;
  onDeleteRepayment: (repayment: DebtRepaymentRead) => void;
  onClose: () => void;
}

/**
 * The repayments of one debt, in a window over /debts (the /categories
 * drill-down pattern: the question is asked from a row and belongs next to it).
 *
 * The rows come from `GET /debts/{id}` — the architecture EMBEDS the history in
 * the detail response (a debt has a handful of movements, so one request and no
 * third endpoint). The list row carries only `repayments_count`, which is why
 * this is a read of its own rather than a lookup in the cached list.
 *
 * Editing or deleting a repayment opens its own dialog, and this window CLOSES
 * when it does: a Modal inside an open Modal would be two document-level Esc
 * handlers and two focus traps fighting over the same Tab (the rule
 * TransactionRow states for the same reason). The caller owns that switch, and
 * brings the user back here afterwards.
 */
export function DebtHistoryModal({
  debt,
  onRecordRepayment,
  onEditRepayment,
  onDeleteRepayment,
  onClose,
}: DebtHistoryModalProps) {
  const locale = useLocale();
  const t = useT();
  const query = useDebt(debt.id);
  const phase = queryPhase(query);
  // The list row renders the lede — it is already in the cache, so the figures
  // are there on the first frame and move with every invalidation; the detail
  // read only adds the rows.
  const repayments = query.data?.repayments;

  return (
    <Modal title={t('debtHistory.title')} onClose={onClose}>
      <p className={styles.lede}>
        {t('debtHistory.lede', {
          name: debt.counterparty,
          amount: formatMoney(debt.remaining_minor, debt.currency, { locale }),
          principal: formatMoney(debt.principal_minor, debt.currency, { locale }),
        })}
      </p>

      {phase === 'loading' ? (
        // Fixed-height placeholders, so the dialog does not jump when they land.
        <ul className={styles.list} aria-hidden="true">
          <li className={styles.skeletonRow} />
          <li className={styles.skeletonRow} />
        </ul>
      ) : phase === 'error' || phase === 'unreachable' ? (
        <QueryStateNotice
          phase={phase}
          message={t('debtHistory.loadFailed')}
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : repayments === undefined || repayments.length === 0 ? (
        <p className={styles.empty}>{t('debtHistory.empty')}</p>
      ) : (
        <ul className={styles.list}>
          {repayments.map((repayment) => (
            <li key={repayment.id} className={styles.row}>
              <span className={styles.when}>
                {formatApiDate(repayment.occurred_at, { locale })}
              </span>
              <span className={`${styles.amount} tnum`}>
                {formatMoney(repayment.amount_minor, debt.currency, { locale })}
              </span>
              {/* The account figure is only worth a line when it is a DIFFERENT
                  number — i.e. when the account is in another currency. Both
                  figures are server fields; nothing is converted here. */}
              {repayment.account_currency === debt.currency ? null : (
                <span className={`${styles.secondary} tnum`}>
                  {t('debtHistory.onAccount', {
                    amount: formatMoney(
                      repayment.account_amount_minor,
                      repayment.account_currency,
                      { locale },
                    ),
                  })}
                </span>
              )}
              <span className={styles.rowActions}>
                <Button size="sm" onClick={() => onEditRepayment(repayment)}>
                  {t('common.edit')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => onDeleteRepayment(repayment)}>
                  {t('common.delete')}
                </Button>
              </span>
              {/* The user's own note — never translated. */}
              {repayment.note ? <span className={styles.note}>{repayment.note}</span> : null}
            </li>
          ))}
        </ul>
      )}

      <div className={styles.actions}>
        {/* A settled debt owes nothing, so there is nothing to record — the
            affordance is absent rather than dead (the row's rule). */}
        {debt.status === 'open' ? (
          <Button variant="primary" onClick={onRecordRepayment}>
            {t('debts.recordRepayment')}
          </Button>
        ) : null}
        <Button onClick={onClose}>{t('common.close')}</Button>
      </div>
    </Modal>
  );
}
