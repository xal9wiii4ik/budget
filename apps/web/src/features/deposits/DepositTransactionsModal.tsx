import { currentMonth } from '@budget/shared';
import type { components } from '@budget/api-client';
import { useMemo } from 'react';

import { useAccounts } from '../../data/accounts';
import { useDeposits, type DepositRead } from '../../data/deposits';
import { useSummary, useTransactions } from '../../data/transactions';
import { useLocale, useT } from '../../i18n/context';
import { queryPhase } from '../../lib/queryPhase';
import { TransactionList } from '../transactions/TransactionList';
import { TxWindowModal } from '../transactions/TxWindowModal';
import { useTxWindowPeriod } from '../transactions/useTxWindowPeriod';
import {
  txWindowFilters,
  txWindowHref,
  txWindowPeriodLabel,
  type TxWindowFilter,
} from '../transactions/txWindow';
import { mergedAccountIndex } from './depositAccounts';
import styles from './DepositTransactionsModal.module.css';

// /deposits does not hold the template list and will not fetch one for a chip —
// an unresolved id lands in the row's documented name-less arm, never blocking a
// row. (A deposit's own rows are transfers, which no template creates today.)
const NO_TEMPLATES: Map<string, { name: string }> = new Map();
// categories: this screen fetches none, and a transfer HAS no category — an
// ordinary row (were one ever booked on a deposit ledger) falls into the row's
// own name-less arm instead of blocking on a request /deposits does not make.
const NO_CATEGORIES: Map<string, components['schemas']['CategoryRead']> = new Map();

interface DepositTransactionsModalProps {
  deposit: DepositRead;
  onClose: () => void;
}

/**
 * One deposit's movements, over the screen that listed it — the same window the
 * category drill-down opens (`TxWindowModal`), with two deliberate differences.
 *
 * NO TOTAL. A deposit's history is TRANSFERS, and a transfer is not spending: it
 * carries no category and is excluded from every /stats aggregate by design.
 * There is no server field that totals an account's movements over a period, and
 * summing the rows here would be exactly the client-side money arithmetic this
 * codebase forbids — with a sign per leg and a currency per leg, it would not
 * even be one number. The figures a deposit HAS (its body and its interest) are
 * server fields, and they are on the row behind this window.
 *
 * REAL account names. Under a category filter a row can never be a transfer, so
 * that window passes an empty account index; here nearly every row is one, and
 * both its ends must be nameable — including the deposit's own ledger account,
 * which `GET /accounts` hides, hence `mergedAccountIndex` over both lists.
 * `viewAccountId` then makes each row show the leg belonging to THIS account with
 * its own sign (`signedLegFor`), so a top-up reads "+" here and a withdrawal "−".
 *
 * The rows come from the SAME query (same key, same page size) /transactions uses
 * for `?account=…`, so the window and the full screen share one cache entry.
 */
export function DepositTransactionsModal({
  deposit,
  onClose,
}: DepositTransactionsModalProps) {
  const t = useT();
  const locale = useLocale();
  const { period, monthAnchor, onRangeChange } = useTxWindowPeriod();
  // The LEDGER account id — that is what a transaction row points at; the
  // deposit's own id means nothing to /transactions.
  const filter: TxWindowFilter = { kind: 'account', accountId: deposit.account_id };

  const txQuery = useTransactions(txWindowFilters(filter, period));
  const txPhase = queryPhase(txQuery);
  const transactions = txQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const total = txQuery.data?.pages[0]?.total ?? 0;

  // Names for the OTHER side of each transfer. Both reads are 60s-cached and the
  // deposits one is already on this screen; while they are pending or errored the
  // index is empty and rows render their amounts without the route (the shipped
  // rule), rather than blocking.
  const accountsQuery = useAccounts();
  const depositsQuery = useDeposits();
  const accountsById = useMemo(
    () => mergedAccountIndex(accountsQuery.data ?? [], depositsQuery.data ?? []),
    [accountsQuery.data, depositsQuery.data],
  );

  // The profile base currency, for the "≈" line on an ordinary row. This month's
  // summary is already in the /deposits cache, and a transfer row ignores it
  // (a transfer has no base snapshot by construction).
  const summaryQuery = useSummary(currentMonth());

  // The list's empty branch is unreachable — the window renders its own empty
  // state — and these callbacks live only inside it: "add a transaction" and
  // "clear this filter" are both meaningless in a window that IS one account.
  const unreachable = () => {};

  return (
    <TxWindowModal
      title={deposit.name}
      period={period}
      monthAnchor={monthAnchor}
      onRangeChange={onRangeChange}
      // The headline slot carries a sentence, not a number: it says what these
      // rows are and, by naming where the body and the interest live, why there
      // is no total over them.
      headline={<p className={styles.note}>{t('depositTx.lede')}</p>}
      emptyMessage={
        txPhase === 'ready' && transactions.length === 0
          ? t('depositTx.empty')
          : undefined
      }
      listLabel={t('depositTx.listLabel', { name: deposit.name })}
      href={txWindowHref(filter, period)}
      onClose={onClose}
    >
      <TransactionList
        transactions={transactions}
        total={total}
        phase={txPhase}
        hasMore={txQuery.hasNextPage}
        isLoadingMore={txQuery.isFetchingNextPage}
        periodLabel={txWindowPeriodLabel(period, t, locale)}
        categoryIndex={NO_CATEGORIES}
        summaryCurrency={summaryQuery.data?.currency}
        recurringIndex={NO_TEMPLATES}
        accountsById={accountsById}
        // The whole point of an account window: one leg per row, with this
        // account's sign (A3).
        viewAccountId={deposit.account_id}
        categoryFiltered={false}
        allTime={false}
        otherFiltered={false}
        grouped
        onClearAccountFilter={unreachable}
        onClearCategoryFilter={unreachable}
        onClearOtherFilters={unreachable}
        onLoadMore={() => {
          void txQuery.fetchNextPage();
        }}
        onRetry={() => {
          void txQuery.refetch();
        }}
        // No `onEdit`: the rows are read-only in here — a form inside an open
        // Modal would be a second dialog in the first one's DOM subtree
        // (TransactionRow). The transfer form is reachable from /transactions.
        onAddFirst={unreachable}
      />
    </TxWindowModal>
  );
}
