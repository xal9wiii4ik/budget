import { formatApiDate, formatMoney, signedLegFor } from '@budget/shared';
import type { components } from '@budget/api-client';
import type { ReactNode } from 'react';

import { Badge } from '../../components/Badge';
import type { NamedAccount } from '../accounts/accountOptions';
import { useLocale, useT } from '../../i18n/context';
import { recurringBadge } from './recurringBadge';
import { transferDisplay, type TransferLeg } from './transferDisplay';
import { primaryAmount, rowTitle } from './rowDisplay';
import styles from './TransactionList.module.css';

type CategoryRead = components['schemas']['CategoryRead'];
type TransactionRead = components['schemas']['TransactionRead'];

interface TransactionRowProps {
  transaction: TransactionRead;
  category: CategoryRead | undefined;
  // The month summary's currency = the profile base currency. `undefined` while
  // the summary is still loading/errored: rows then render their own amount only
  // — a base equivalent cannot be judged stale without knowing the base.
  summaryCurrency: string | undefined;
  // id -> template, from the cached ['recurring','list'] query (W3). Empty while
  // that query is pending or errored, which lands in the same name-less arm as a
  // cache miss — the badge never blocks or delays a row.
  recurringIndex: Map<string, { name: string }>;
  // Account id -> its display entry (W1), merged with deposit ledgers since
  // deposits W1. Only the transfer arm reads it, and only for NAMES: both
  // amounts and both currencies come from the row itself.
  accountsById: Map<string, NamedAccount>;
  // The account the list is filtered by (W2), or undefined for the all-accounts
  // list. A transfer matches BOTH its legs server-side, so under a filter the
  // row must show the leg belonging to THIS account, with THIS account's sign.
  viewAccountId?: string;
  // S3: the list drops its day headers under an amount sort, so the row itself
  // states its date. False in the grouped layout, where the header already does.
  showDate?: boolean;
  /**
   * Opens the edit form. OPTIONAL since category-popup-and-ui-polish: the
   * category modal lists the same rows READ-ONLY, because opening the form from
   * inside an open Modal would mount a second Modal in the first one's DOM
   * subtree — two document-level Esc handlers (which close both dialogs at once)
   * and two focus traps fighting over the same Tab. Undefined renders the row as
   * static markup, not as a button that does nothing.
   */
  onEdit?: (transaction: TransactionRead) => void;
}

/**
 * The row's outer element: a <button> when there is something to open, plain
 * markup when there is not. One place decides it, so the transfer arm and the
 * ordinary arm can never disagree about whether a row is a control.
 */
function RowShell({
  transaction,
  onEdit,
  children,
}: {
  transaction: TransactionRead;
  onEdit: ((transaction: TransactionRead) => void) | undefined;
  children: ReactNode;
}) {
  if (onEdit === undefined) {
    return <div className={`${styles.row} ${styles.rowStatic}`}>{children}</div>;
  }
  return (
    <button type="button" className={styles.row} onClick={() => onEdit(transaction)}>
      {children}
    </button>
  );
}

/**
 * One transaction row. The stored amount_minor is a magnitude (>=1); the SIGN is
 * carried by kind (T4/T8) — expense renders as a negative (locale minus via
 * formatMoney, red), income as positive (green). No toFixed / float. The category
 * icon is joined from the archived-inclusive index.
 *
 * 3.2: every amount renders with the currency of the FIELD it came from (T8′) —
 * a foreign row shows its stored base-currency snapshot as a muted "≈" line,
 * decoded with that snapshot's own paired currency.
 *
 * transaction-details-and-i18n S1/S4: the title is the operation's NAME when it
 * has one (merchant), and a purchase made in another currency leads with what was
 * SPENT over what the account was CHARGED. Both rules are pure and tested in
 * rowDisplay.ts — this component only renders them.
 *
 * 5.3: a row a template created carries a "Recurring" chip — the honesty
 * mechanism for silent materialization (D9). Read-only: the badge changes no
 * write path and no invalidation.
 */
export function TransactionRow({
  transaction,
  category,
  summaryCurrency,
  recurringIndex,
  accountsById,
  viewAccountId,
  showDate = false,
  onEdit,
}: TransactionRowProps) {
  // accounts-and-transfers W1: a transfer is ONE row showing BOTH sides (A1) —
  // it has no category and no base equivalent (its base pair is NULL by CHECK,
  // §5), so it takes its own branch instead of threading nulls through this one.
  const locale = useLocale();
  const t = useT();

  if (transaction.kind === 'transfer') {
    return (
      <TransferRow
        transaction={transaction}
        accountsById={accountsById}
        viewAccountId={viewAccountId}
        showDate={showDate}
        onEdit={onEdit}
      />
    );
  }

  const isExpense = transaction.kind === 'expense';
  const name = rowTitle(transaction, category, {
    uncategorized: t('common.uncategorized'),
    unknownCategory: t('common.unknownCategory'),
  });
  // At most two money lines, and which two depends on the row (see rowDisplay):
  // a foreign purchase shows what was SPENT over what the account was CHARGED,
  // everything else shows its own amount over the base-currency snapshot.
  const amounts = primaryAmount(transaction, summaryCurrency);
  const sign = (minor: number) => (isExpense ? -minor : minor);
  const recurring = recurringBadge(transaction, recurringIndex);

  return (
    <RowShell transaction={transaction} onEdit={onEdit}>
      <span className={styles.icon} aria-hidden="true">
        {category?.icon ?? '•'}
      </span>
      <span className={styles.details}>
        <span className={styles.categoryName}>{name}</span>
        {recurring ? (
          // A static badge, not a control: the row itself is the <button> and
          // nothing focusable may nest inside it.
          <Badge tone="accent" className={styles.recurringChip}>
            <span className={styles.chipText}>
              {t('tx.recurringChip')}
              {recurring.name === undefined ? '' : ` · ${recurring.name}`}
            </span>
          </Badge>
        ) : null}
        {transaction.note ? <span className={styles.note}>{transaction.note}</span> : null}
        {showDate ? (
          <span className={styles.rowDate}>
            {formatApiDate(transaction.occurred_at, { locale })}
          </span>
        ) : null}
      </span>
      <span className={styles.amountCell}>
        <span className={`${styles.amount} ${isExpense ? styles.expense : styles.income} tnum`}>
          {formatMoney(sign(amounts.primary.minor), amounts.primary.currency, { locale })}
        </span>
        {/* Plain text, never a hover affordance: on a foreign purchase this is
            the only line that reconciles with the month's total. */}
        {amounts.secondary ? (
          <span className={`${styles.baseEquivalent} tnum`}>
            {amounts.secondary.kind === 'base' ? '≈ ' : ''}
            {formatMoney(sign(amounts.secondary.minor), amounts.secondary.currency, {
              locale,
            })}
          </span>
        ) : null}
      </span>
    </RowShell>
  );
}

/**
 * A transfer row: "Card USD → Card BYN" with the money that actually moved —
 * OUT of the source in the source's currency, IN to the target in the target's
 * currency (A5 puts `counter_currency` on the row, so neither amount waits for
 * the account list; only the two names are joined from it).
 *
 * Under an account filter the row shows ONE leg: the one belonging to the account
 * being viewed, chosen by the shared `signedLegFor` (A3) — the same rule the
 * mobile client uses. That is why the same transfer reads "−100.00 USD" in the
 * source account's history and "+330.00 BYN" in the target's.
 *
 * The sign is a DIRECTION marker, not arithmetic: the stored magnitudes are
 * rendered with a leading minus/plus by `formatMoney`, and nothing here adds,
 * subtracts or divides them. In particular the exchange rate is NOT computed
 * here — `transfer_rate` is a server field (A2) printed verbatim under the
 * amounts (same string the form shows), including under an account filter: the
 * rate is a property of the transfer, not of the leg being looked at.
 *
 * Clicking opens the ONE form that edits both sides together (A1).
 */
function TransferRow({
  transaction,
  accountsById,
  viewAccountId,
  showDate,
  onEdit,
}: {
  transaction: TransactionRead;
  accountsById: Map<string, NamedAccount>;
  viewAccountId: string | undefined;
  showDate: boolean;
  onEdit: ((transaction: TransactionRead) => void) | undefined;
}) {
  const locale = useLocale();
  const t = useT();
  const display = transferDisplay(transaction, (id) => accountsById.get(id)?.name);
  // `null` only if the filtered account is on neither leg (the server cannot
  // return such a row) or the counter pair is missing — both fall back to the
  // two-sided rendering rather than to an invented amount.
  const leg = viewAccountId === undefined ? null : signedLegFor(transaction, viewAccountId);

  return (
    <RowShell transaction={transaction} onEdit={onEdit}>
      <span className={styles.icon} aria-hidden="true">
        ⇄
      </span>
      <span className={styles.details}>
        {/* Never "Uncategorized": a transfer HAS no category (that word belongs to
            spending without one), so the two accounts take that line. Names are
            omitted, not guessed, while the account list is still loading. */}
        <span className={styles.categoryName}>
          {display.route === null
            ? t('tx.transfer')
            : t('tx.transferRoute', { route: display.route })}
        </span>
        {transaction.note ? <span className={styles.note}>{transaction.note}</span> : null}
        {showDate ? (
          <span className={styles.rowDate}>
            {formatApiDate(transaction.occurred_at, { locale })}
          </span>
        ) : null}
      </span>
      <span className={styles.amountCell}>
        {leg !== null ? (
          <LegAmount leg={leg} />
        ) : (
          <>
            <LegAmount leg={display.sent} />
            {display.received === null ? null : <LegAmount leg={display.received} />}
          </>
        )}
        {display.rate === null ? null : (
          <span className={`${styles.transferRate} tnum`}>{display.rate}</span>
        )}
      </span>
    </RowShell>
  );
}

/**
 * One transfer leg. Coloured as a TRANSFER, not as spending or income: money
 * moving between the user's own accounts is neither, and the direction is
 * already in the figure (the sign comes in already applied).
 */
function LegAmount({ leg }: { leg: TransferLeg }) {
  const locale = useLocale();
  return (
    <span className={`${styles.amount} ${styles.transfer} tnum`}>
      {formatMoney(leg.signedMinor, leg.currency, { locale })}
    </span>
  );
}
