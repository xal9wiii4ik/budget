import { formatMoney } from '@budget/shared';
import type { components } from '@budget/api-client';

import { QueryStateNotice } from '../../components/QueryStateNotice';
import type { NamedAccount } from '../accounts/accountOptions';
import { useStatsSummary } from '../../data/stats';
import { useTransactions } from '../../data/transactions';
import { useLocale, useT } from '../../i18n/context';
import { queryPhase } from '../../lib/queryPhase';
import { UnconvertedNotice } from '../stats/UnconvertedNotice';
import { TransactionList } from '../transactions/TransactionList';
import { TxWindowModal } from '../transactions/TxWindowModal';
import { useTxWindowPeriod } from '../transactions/useTxWindowPeriod';
import {
  txWindowFilters,
  txWindowHref,
  txWindowPeriodLabel,
  type TxWindowFilter,
} from '../transactions/txWindow';
import { categoryPeriodTotal, categoryStatsPeriod } from './categoryDrilldown';
import styles from './CategoryTransactionsModal.module.css';

type CategoryRead = components['schemas']['CategoryRead'];

// Module-level so the identity is stable across renders (these are props of a
// memo-free component tree, but a fresh Map per render is still needless work).
//
// recurring: /categories does not hold the template list, and the modal will not
// fetch one for a chip — an unresolved id lands in the row's documented
// name-less arm ("Recurring" with no template name), never blocking a row.
const NO_TEMPLATES: Map<string, { name: string }> = new Map();
// accounts: a transfer has NO category (its category_id is null by design), so a
// category-filtered list cannot contain one and the transfer arm's name lookup
// is unreachable here.
const NO_ACCOUNTS: Map<string, NamedAccount> = new Map();
// debts: a debt movement carries no category either (the CHECK forbids it), so a
// category-filtered list cannot contain one and the badge is unreachable here.
const NO_DEBTS: Map<string, string> = new Map();

interface CategoryTransactionsModalProps {
  category: CategoryRead;
  onClose: () => void;
}

/**
 * One category's operations, over the screen that listed it (task.md 2). The
 * window itself — period control, scroll region, "open all operations" — is the
 * shared `TxWindowModal`; what is category-specific lives here.
 *
 * The headline is `/stats/summary`'s own `total_minor` for this category, picked
 * by id and kind (`categoryPeriodTotal`) — the client sums nothing. That is also
 * why the window has no all-time mode: the stats period grammar has no all-time
 * unit, and a list with no total to head it would be exactly the question this
 * window exists to answer, unanswered.
 *
 * The rows come from the SAME query (same key, same page size) the /transactions
 * screen uses for this category, so opening the window twice — or opening it and
 * then the full screen — reuses one cache entry instead of refetching.
 */
export function CategoryTransactionsModal({
  category,
  onClose,
}: CategoryTransactionsModalProps) {
  const t = useT();
  const locale = useLocale();
  const { period, monthAnchor, onRangeChange } = useTxWindowPeriod();
  const filter: TxWindowFilter = { kind: 'category', categoryId: category.id };

  const summaryQuery = useStatsSummary(categoryStatsPeriod(period));
  const summaryPhase = queryPhase(summaryQuery);

  // Byte-for-byte the filter slice /transactions builds for `?category=…` with
  // this window (txWindow.ts), so both read one cache entry.
  const txQuery = useTransactions(txWindowFilters(filter, period));
  const txPhase = queryPhase(txQuery);
  const transactions = txQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const total = txQuery.data?.pages[0]?.total ?? 0;

  // The list's empty branch is unreachable here — the window renders its own
  // empty state — and these four callbacks live only inside it: "add a
  // transaction" and "clear this filter" are both meaningless in a window that
  // IS one category.
  const unreachable = () => {};

  const headline =
    summaryPhase === 'loading' ? (
      <div className={styles.totalSkeleton} aria-hidden="true" />
    ) : summaryPhase === 'error' || summaryPhase === 'unreachable' ? (
      <QueryStateNotice
        phase={summaryPhase}
        message={t('categoryTx.totalFailed')}
        compact
        onRetry={() => {
          void summaryQuery.refetch();
        }}
      />
    ) : summaryQuery.data === undefined ? null : (
      <div className={styles.total}>
        <span className={styles.totalLabel}>{t('categoryTx.total')}</span>
        <strong className={`${styles.totalValue} tnum`}>
          {formatMoney(
            categoryPeriodTotal(summaryQuery.data, category.id, category.kind),
            // The response's OWN currency (the profile base) — never a currency
            // from somewhere else on the screen.
            summaryQuery.data.currency,
            { locale },
          )}
        </strong>
        {/* The count is the MONTH's, not this category's: the summary carries one
            figure for the period, so the sentence must not claim more than it knows. */}
        <UnconvertedNotice count={summaryQuery.data.unconverted_count} scope="month" />
      </div>
    );

  return (
    <TxWindowModal
      title={category.name}
      period={period}
      monthAnchor={monthAnchor}
      onRangeChange={onRangeChange}
      headline={headline}
      emptyMessage={
        txPhase === 'ready' && transactions.length === 0
          ? t('categoryTx.empty')
          : undefined
      }
      // The same sentence the drill-down button carries.
      listLabel={t('categories.viewTransactionsFor', { name: category.name })}
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
        // Every row in this list is in THIS category (the server filtered them),
        // so the one entry is the whole join.
        categoryIndex={new Map([[category.id, category]])}
        // = the profile base currency, from the response that already has to be
        // on screen for the total.
        summaryCurrency={summaryQuery.data?.currency}
        recurringIndex={NO_TEMPLATES}
        accountsById={NO_ACCOUNTS}
        debtIndex={NO_DEBTS}
        categoryFiltered
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
        // No `onEdit`: the rows are read-only in here (TransactionRow).
        onAddFirst={unreachable}
      />
    </TxWindowModal>
  );
}
