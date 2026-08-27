import { formatApiDate, formatMoney } from '@budget/shared';

import type { DepositRead } from '../../data/deposits';
import { useLocale, useT } from '../../i18n/context';
import { depositRowState, type DepositBadge } from './depositStatus';
import styles from './DepositList.module.css';

interface DepositRowProps {
  deposit: DepositRead;
  onEdit: (deposit: DepositRead) => void;
  onTopUp: (deposit: DepositRead) => void;
  onWithdraw: (deposit: DepositRead) => void;
  onEditAccrued: (deposit: DepositRead) => void;
  onHistory: (deposit: DepositRead) => void;
}

const BADGE_KEY = {
  archived: 'deposits.badgeArchived',
  matured: 'deposits.badgeMatured',
  overridden: 'deposits.badgeOverridden',
} as const satisfies Record<DepositBadge, string>;

const CAPITALIZATION_KEY = {
  none: 'deposits.capNone',
  monthly: 'deposits.capMonthly',
  quarterly: 'deposits.capQuarterly',
  at_maturity: 'deposits.capAtMaturity',
} as const satisfies Record<DepositRead['capitalization'], string>;

/**
 * One deposit: the BODY and the INTEREST, side by side and never added together.
 *
 * Every figure on this row is a server field — `balance_minor` (the ledger
 * account's balance), `accrued_minor` (the forecast as of today) and
 * `accrued_after_tax_minor` (null when the deposit is not taxed). The client
 * neither sums them nor converts them: "body + interest" is a number the bank
 * pays out at maturity, not one a browser may invent, and the two are shown as
 * two labelled figures precisely so nobody reads a total that is not there.
 *
 * Not a single big `<button>` like AccountRow: a deposit has FOUR things you can
 * do to it, so the row is an article with its own actions and the name is a
 * heading rather than button text.
 */
export function DepositRow({
  deposit,
  onEdit,
  onTopUp,
  onWithdraw,
  onEditAccrued,
  onHistory,
}: DepositRowProps) {
  const locale = useLocale();
  const t = useT();
  const state = depositRowState(deposit);

  return (
    <article className={deposit.archived ? `${styles.row} ${styles.archived}` : styles.row}>
      <header className={styles.head}>
        <h3 className={styles.name}>{deposit.name}</h3>
        {state.badges.length > 0 ? (
          <span className={styles.badges}>
            {state.badges.map((badge) => (
              // Text badges, never colour alone.
              <span className={styles.badge} key={badge}>
                {t(BADGE_KEY[badge])}
              </span>
            ))}
          </span>
        ) : null}
      </header>

      <dl className={styles.figures}>
        <div className={styles.figure}>
          <dt className={styles.figureLabel}>{t('deposits.body')}</dt>
          <dd className={styles.figureValue}>
            {formatMoney(deposit.balance_minor, deposit.currency, { locale })}
          </dd>
        </div>
        <div className={styles.figure}>
          <dt className={styles.figureLabel}>{t('deposits.accrued')}</dt>
          <dd className={styles.figureValue}>
            {formatMoney(deposit.accrued_minor, deposit.currency, { locale })}
            {/* `!== null`, never truthiness: 0 after tax is a real figure. */}
            {state.showAfterTax && deposit.accrued_after_tax_minor !== null ? (
              <span className={styles.afterTax}>
                {' · '}
                {formatMoney(deposit.accrued_after_tax_minor, deposit.currency, { locale })}{' '}
                {t('deposits.afterTax')}
              </span>
            ) : null}
          </dd>
        </div>
      </dl>

      <p className={styles.meta}>
        {/* `rate_percent` is the SERVER's decimal string, interpolated verbatim —
            never parsed, rounded or recomputed. */}
        {t('deposits.rate', { rate: deposit.rate_percent })} ·{' '}
        {t(CAPITALIZATION_KEY[deposit.capitalization])} ·{' '}
        {t('deposits.opened', { date: formatApiDate(deposit.opened_on, { locale }) })} ·{' '}
        {deposit.term_end === null
          ? t('deposits.openEnded')
          : t('deposits.term', { date: formatApiDate(deposit.term_end, { locale }) })}
      </p>

      {/* The manual anchor, with its date and what it keeps doing (the forecast
          continues FROM it — it is not a one-off correction). */}
      {state.isOverridden && deposit.accrued_override_as_of !== null ? (
        <p className={styles.override}>
          {t('deposits.overrideAsOf', {
            date: formatApiDate(deposit.accrued_override_as_of, { locale }),
          })}
        </p>
      ) : null}

      <div className={styles.actions}>
        {/* Money moves through the ORDINARY transfer form; an archived deposit
            takes none, so those two buttons are absent rather than dead. */}
        {state.canMoveMoney ? (
          <>
            <button type="button" className={styles.action} onClick={() => onTopUp(deposit)}>
              {t('deposits.topUp')}
            </button>
            <button
              type="button"
              className={styles.action}
              onClick={() => onWithdraw(deposit)}
            >
              {t('deposits.withdraw')}
            </button>
          </>
        ) : null}
        {/* The manual anchor is a PATCH on the deposit, which an archived one
            refuses (DEPOSIT_ARCHIVED) — so the affordance goes with it. The
            figure itself stays on the row above: the record still reads. */}
        {state.canEditTerms ? (
          <button
            type="button"
            className={styles.action}
            onClick={() => onEditAccrued(deposit)}
          >
            {t('deposits.accruedToday')}
          </button>
        ) : null}
        <button type="button" className={styles.action} onClick={() => onEdit(deposit)}>
          {t('common.edit')}
        </button>
        {/* The deposit's history IS the transactions list filtered by its ledger
            account — the server matches either leg of a transfer, so this is the
            top-ups and withdrawals, with no second list to build. It opens as a
            WINDOW over this screen (the /categories drill-down pattern): the
            question is asked from this row and belongs next to it. The full
            screen stays one click away, from inside that window. */}
        <button
          type="button"
          className={styles.action}
          onClick={() => onHistory(deposit)}
        >
          {t('deposits.history')}
        </button>
      </div>
    </article>
  );
}
