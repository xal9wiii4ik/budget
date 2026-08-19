import { formatMoney, signedLegFor } from '@budget/shared';
import type { components } from '@budget/api-client';

import type { AccountRead } from '../../data/accounts';
import { recurringBadge } from './recurringBadge';
import { transferDisplay, type TransferLeg } from './transferDisplay';
import { baseEquivalent } from './rowDisplay';
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
  // Account id -> account (W1). Only the transfer arm reads it, and only for
  // NAMES: both amounts and both currencies come from the row itself.
  accountsById: Map<string, AccountRead>;
  // The account the list is filtered by (W2), or undefined for the all-accounts
  // list. A transfer matches BOTH its legs server-side, so under a filter the
  // row must show the leg belonging to THIS account, with THIS account's sign.
  viewAccountId?: string;
  onEdit: (transaction: TransactionRead) => void;
}

/**
 * One transaction row. The stored amount_minor is a magnitude (>=1); the SIGN is
 * carried by kind (T4/T8) — expense renders as a negative (locale minus via
 * formatMoney, red), income as positive (green). No toFixed / float. The category
 * name/icon is joined from the archived-inclusive index; a null category renders
 * "Uncategorized".
 *
 * 3.2: the primary amount is ALWAYS the row's own currency (T8′). A foreign row
 * additionally shows its stored base-currency snapshot as a muted "≈" line,
 * decoded with that snapshot's own paired currency (see rowDisplay).
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
  onEdit,
}: TransactionRowProps) {
  // accounts-and-transfers W1: a transfer is ONE row showing BOTH sides (A1) —
  // it has no category and no base equivalent (its base pair is NULL by CHECK,
  // §5), so it takes its own branch instead of threading nulls through this one.
  if (transaction.kind === 'transfer') {
    return (
      <TransferRow
        transaction={transaction}
        accountsById={accountsById}
        viewAccountId={viewAccountId}
        onEdit={onEdit}
      />
    );
  }

  const isExpense = transaction.kind === 'expense';
  const signedMinor = isExpense ? -transaction.amount_minor : transaction.amount_minor;
  const name =
    transaction.category_id === null ? 'Uncategorized' : (category?.name ?? 'Unknown category');
  const equivalent =
    summaryCurrency === undefined ? null : baseEquivalent(transaction, summaryCurrency);
  const recurring = recurringBadge(transaction, recurringIndex);

  return (
    <button type="button" className={styles.row} onClick={() => onEdit(transaction)}>
      <span className={styles.icon} aria-hidden="true">
        {category?.icon ?? '•'}
      </span>
      <span className={styles.details}>
        <span className={styles.categoryName}>{name}</span>
        {recurring ? (
          // A static <span>, not a control: the row itself is the <button> and
          // nothing focusable may nest inside it.
          <span className={styles.recurringChip}>
            Recurring{recurring.name === undefined ? '' : ` · ${recurring.name}`}
          </span>
        ) : null}
        {transaction.note ? <span className={styles.note}>{transaction.note}</span> : null}
      </span>
      <span className={styles.amountCell}>
        <span className={`${styles.amount} ${isExpense ? styles.expense : styles.income}`}>
          {formatMoney(signedMinor, transaction.currency)}
        </span>
        {equivalent ? (
          <span className={styles.baseEquivalent}>
            ≈ {formatMoney(isExpense ? -equivalent.minor : equivalent.minor, equivalent.currency)}
          </span>
        ) : null}
      </span>
    </button>
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
  onEdit,
}: {
  transaction: TransactionRead;
  accountsById: Map<string, AccountRead>;
  viewAccountId: string | undefined;
  onEdit: (transaction: TransactionRead) => void;
}) {
  const display = transferDisplay(transaction, (id) => accountsById.get(id)?.name);
  // `null` only if the filtered account is on neither leg (the server cannot
  // return such a row) or the counter pair is missing — both fall back to the
  // two-sided rendering rather than to an invented amount.
  const leg = viewAccountId === undefined ? null : signedLegFor(transaction, viewAccountId);

  return (
    <button type="button" className={styles.row} onClick={() => onEdit(transaction)}>
      <span className={styles.icon} aria-hidden="true">
        ⇄
      </span>
      <span className={styles.details}>
        {/* Never "Uncategorized": a transfer HAS no category (that word belongs to
            spending without one), so the two accounts take that line. Names are
            omitted, not guessed, while the account list is still loading. */}
        <span className={styles.categoryName}>
          Transfer{display.route === null ? '' : `: ${display.route}`}
        </span>
        {transaction.note ? <span className={styles.note}>{transaction.note}</span> : null}
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
          <span className={styles.transferRate}>{display.rate}</span>
        )}
      </span>
    </button>
  );
}

/** One transfer leg, coloured by its direction. Sign comes in already applied. */
function LegAmount({ leg }: { leg: TransferLeg }) {
  return (
    <span
      className={`${styles.amount} ${leg.signedMinor < 0 ? styles.expense : styles.income}`}
    >
      {formatMoney(leg.signedMinor, leg.currency)}
    </span>
  );
}
