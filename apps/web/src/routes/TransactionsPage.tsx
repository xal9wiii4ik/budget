import {
  currentMonth,
  formatApiDate,
  formatMonthLabel,
  monthBounds,
  todayApiDateUtc,
} from '@budget/shared';
import type { components } from '@budget/api-client';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';

import { useAccounts } from '../data/accounts';
import { useDeposits } from '../data/deposits';
import { buildCategoryIndex } from '../data/categoryLookup';
import { useCategories } from '../data/categories';
import { useRecurringTemplates, type RecurringTemplateRead } from '../data/recurring';
import {
  useExportTransactions,
  useSummary,
  useTransactions,
  type ExportFilters,
} from '../data/transactions';
import type { TxSort } from '../data/queryKeys';
import { downloadBlob } from '../lib/download';
import { useLang, useLocale, useT } from '../i18n/context';
import { describeExportError } from '../lib/errors';
import { queryPhase } from '../lib/queryPhase';
import { AccountFilter } from '../features/accounts/AccountFilter';
import {
  mergedAccountEntries,
  mergedAccountIndex,
} from '../features/deposits/depositAccounts';
import { depositDeadlineRows } from '../features/deposits/depositDeadlines';
import { GOAL_DEADLINE_DAYS } from '../data/goalDeadlines';
import { GoalDeadlines } from '../features/goals/plan/GoalDeadlines';
import { ReceiptCaptureModal } from '../features/receipts/ReceiptCaptureModal';
import { UpcomingCharges } from '../features/recurring/UpcomingCharges';
import { TransferFormModal } from '../features/transfers/TransferFormModal';
import { SummaryHeader } from '../features/transactions/SummaryHeader';
import { TxRangePicker } from '../features/transactions/TxRangePicker';
import { TransactionFormModal } from '../features/transactions/TransactionFormModal';
import type { TemplatePrefillSource } from '../features/transactions/templatePrefill';
import { TransactionList } from '../features/transactions/TransactionList';
import { TxFiltersPopover } from '../features/transactions/TxFiltersPopover';
import { TxSearchField } from '../features/transactions/TxSearchField';
import { countryLabel } from '../features/transactions/countryOptions';
import {
  activeFilterCount,
  isNarrowed,
  parseTxFilters,
  showsDayGroups,
  txExportFilters,
  txListFilters,
  txRangeMode,
  // R4: the whole month slice in one request; the constant lives with the rest
  // of the key grammar so the category modal cannot pick a different page size
  // and split the cache entry (txFilters.ts).
  TX_LIST_LIMIT,
  type TxRangeMode,
} from '../features/transactions/txFilters';
import styles from './TransactionsPage.module.css';

type TransactionRead = components['schemas']['TransactionRead'];

// Every URL parameter this screen reads is parsed and validated in ONE pure
// module (features/transactions/txFilters.ts), which also owns the omit rules
// that keep the unfiltered month on its historical cache key.

/**
 * The saved filename, built client-side (4.5 W4). The server sends a CONSTANT
 * `Content-Disposition` name, so three exports in a row would overwrite each
 * other in the Downloads folder; naming by what was exported fixes that.
 * Presentation only — no contract implication.
 */
function exportFilename(filters: ExportFilters, month: string): string {
  // S1: no window at all is the all-time export — naming it after a month would
  // describe a slice the file does not contain.
  if (filters.from === undefined || filters.to === undefined) return 'transactions-all.csv';
  const bounds = monthBounds(month);
  return filters.from === bounds.from && filters.to === bounds.to
    ? `transactions-${month}.csv`
    : `transactions-${filters.from}_${filters.to}.csv`;
}

/**
 * Whether the downloaded CSV carries any data rows. Read from the FILE ITSELF
 * (its first few KB), never from the list's `total`: pre-checking the row count
 * would be a second source of truth about what matched. An empty export is a
 * documented, legitimate outcome (D13: headers only), and a silent download in a
 * browser that saves without prompting is indistinguishable from a no-op — so the
 * confirmation line has to be able to say which one happened.
 */
async function isHeaderOnly(blob: Blob): Promise<boolean> {
  const head = await blob.slice(0, 4096).text();
  return head.split(/\r?\n/).filter((line) => line.trim() !== '').length <= 1;
}

type ModalState =
  | { type: 'closed' }
  | { type: 'create' }
  | { type: 'edit'; transaction: TransactionRead }
  // accounts-and-transfers W1: a transfer is ONE operation with two sides (A1),
  // edited by its own form — the transaction form has no second account, no
  // second amount, and could only ever show half of it.
  | { type: 'createTransfer' }
  | { type: 'editTransfer'; transfer: TransactionRead }
  // S5: ONE variant for the whole photo flow — the capture modal swaps its own
  // body to the transaction form when the flow gets there (R6).
  | { type: 'receipt' }
  // recurring-book-now W1: the "+" on an upcoming row. An ordinary create,
  // prefilled from the template, dated on the row's own due date (R4). The date
  // is captured at CLICK time so a re-render cannot move it.
  | { type: 'createFromTemplate'; source: TemplatePrefillSource; occurredAt: string };

export function TransactionsPage() {
  const lang = useLang();
  const locale = useLocale();
  const t = useT();
  const [searchParams, setSearchParams] = useSearchParams();
  // The whole filter set — month, all-time flag, account, category, search,
  // country, sort — read out of the URL in one place, with every junk value
  // already collapsed to "no filter" (S3).
  const selection = parseTxFilters(searchParams, currentMonth());
  const { month, allTime, accountId, categoryId } = selection;
  // Which of the three windows is on screen — month, all time, or a custom
  // period — as one value the whole page switches on (`txRangeMode`).
  const mode = txRangeMode(selection);

  const filters = txListFilters(selection, TX_LIST_LIMIT);

  const txQuery = useTransactions(filters);
  const summaryQuery = useSummary(month);
  const categoriesQuery = useCategories();
  // W3: the row badge needs a NAME, and the wire carries only the template id
  // (D10). One small, 60s-cached request per visit resolves every badge on the
  // screen; while it is pending or errored the index is empty and the chips
  // render name-less (SL-C) rather than blocking a row. Read-only — this screen
  // performs no template mutation and invalidates nothing recurring.
  const recurringQuery = useRecurringTemplates();
  // The account list feeds three things at once: the form pickers, the transfer
  // row's "A → B" names, and (W2) the account filter. One 60s-cached read.
  const accountsQuery = useAccounts();
  // deposits W1. Deposit LEDGER accounts are hidden from GET /accounts, so this
  // second 60s-cached read is what lets three things on this screen name them: a
  // transfer row's "A → B", the account filter's options, and the deadline
  // widget's deposit rows. It feeds no picker and no total — the money on a
  // deposit is deliberately absent from both.
  const depositsQuery = useDeposits();

  const categoryIndex = useMemo(
    () => buildCategoryIndex(categoriesQuery.data ?? []),
    [categoriesQuery.data],
  );

  const accountsById = useMemo(
    () => mergedAccountIndex(accountsQuery.data ?? [], depositsQuery.data ?? []),
    [accountsQuery.data, depositsQuery.data],
  );

  // The filter's option list, same two sources and same order.
  const filterAccounts = useMemo(
    () => mergedAccountEntries(accountsQuery.data ?? [], depositsQuery.data ?? []),
    [accountsQuery.data, depositsQuery.data],
  );

  // Deposits whose term ends inside the widget's own horizon. Date comparison
  // only — the architecture's reason for NOT adding a /deposits/upcoming
  // endpoint: the list is already here, and no money is derived from it.
  // UTC, like the widget's own "today" badge: these dates are compared against
  // the same clock the server decided the deposit's `status` on. The value is a
  // stable string within a day, so it is a real dependency — the window follows
  // the calendar over without a reload.
  const todayUtc = todayApiDateUtc();
  const depositDeadlines = useMemo(
    () => depositDeadlineRows(depositsQuery.data ?? [], todayUtc, GOAL_DEADLINE_DAYS),
    [depositsQuery.data, todayUtc],
  );

  const recurringIndex = useMemo(() => {
    const index = new Map<string, RecurringTemplateRead>();
    for (const template of recurringQuery.data?.items ?? []) index.set(template.id, template);
    return index;
  }, [recurringQuery.data]);

  const [modal, setModal] = useState<ModalState>({ type: 'closed' });

  // The export takes the CURRENT filters verbatim, minus the pagination pair
  // (`limit` is a list concern; an export is the whole matching set — D13). The
  // optional category/kind pair is passed through so it stays correct the day the
  // list grows those controls.
  const exportTransactions = useExportTransactions();
  const [exportNote, setExportNote] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const runExport = async () => {
    // The export takes the SAME filters as the list — the file is what was on
    // screen, not the whole month (OQ-W3) — minus `limit` and `sort`, neither of
    // which the endpoint has (txExportFilters owns that rule).
    const query: ExportFilters = txExportFilters(filters);
    setExportNote(null);
    setExportError(null);
    let blob: Blob;
    try {
      blob = await exportTransactions.mutateAsync(query);
    } catch (error) {
      setExportError(describeExportError(error, lang));
      return;
    }
    const filename = exportFilename(query, month);
    downloadBlob(blob, filename);
    // The peek is only about WORDING: once the file is saved the export
    // succeeded, so a failed peek must never surface as a failed export.
    const headerOnly = await isHeaderOnly(blob).catch(() => false);
    setExportNote(
      t(headerOnly ? 'tx.exportDoneEmpty' : 'tx.exportDone', { file: filename }),
    );
  };

  // One writer for both URL parameters, so a month step never drops the account
  // filter and vice versa.
  const setParams = (
    mutate: (params: URLSearchParams) => void,
    options?: { replace?: boolean },
  ) => {
    // The export confirmation names a file for the slice it exported; keeping it
    // on screen after ANY filter changes would read as a claim about the new one.
    // Every parameter writer goes through here for exactly that reason.
    setExportNote(null);
    setExportError(null);
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      mutate(params);
      return params;
    }, options);
  };

  const setParam = (key: string, next: string | null, options?: { replace?: boolean }) => {
    setParams((params) => {
      if (next === null) params.delete(key);
      else params.set(key, next);
    }, options);
  };

  const setAccount = (next: string | null) => setParam('account', next);
  const setCategory = (next: string | null) => setParam('category', next);
  const setCountry = (next: string | null) => setParam('country', next);
  const setSort = (next: TxSort | null) => setParam('sort', next);
  // REPLACE, not push: the search box commits on a debounce, so pushing would
  // leave one history entry per typed word and the back button would walk the
  // user backwards through their own typing instead of out of the search. Every
  // other filter is a discrete choice and stays pushable (S1 behaviour).
  const setSearch = (next: string | null) => setParam('q', next, { replace: true });
  // The empty state's one way out of "search + filters": the account filter keeps
  // its own separate button, and the sort order is not why the list is empty.
  const clearSearchAndFilters = () =>
    setParams((params) => {
      for (const key of ['q', 'country', 'category']) params.delete(key);
    });
  /**
   * The ONE writer for the range: the three modes are mutually exclusive, so it
   * clears all three parameters and then writes only the chosen one's. A
   * leftover `from=` under `range=all` would make the URL lie about the window
   * — and the URL is what a shared link and F5 restore.
   *
   * `month` is deliberately KEPT (and re-stated) in every mode: leaving all-time
   * or a period returns to the month the user was reading, not to today.
   */
  const setRangeMode = (next: TxRangeMode) =>
    setParams((params) => {
      for (const key of ['range', 'from', 'to']) params.delete(key);
      switch (next.kind) {
        case 'month':
          params.set('month', next.month);
          break;
        case 'all':
          params.set('range', 'all');
          break;
        case 'custom':
          params.set('from', next.from);
          params.set('to', next.to);
          break;
      }
    });

  const transactions = txQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const total = txQuery.data?.pages[0]?.total ?? 0;
  // What the list is showing, in words, for the empty state. Follows the CHOSEN
  // language, not the host locale — and in a custom period it names the period,
  // because "no transactions in August" would be false about a 3-day window.
  const periodLabel =
    mode.kind === 'custom'
      ? t('tx.rangeLabel', {
          from: formatApiDate(mode.from, { locale }),
          to: formatApiDate(mode.to, { locale }),
        })
      : formatMonthLabel(month, { locale });
  const accountsPhase = queryPhase(accountsQuery);
  // The filtered account's NAME, or undefined while the list is loading, errored,
  // or does not know that id. The chip below then says "one account" rather than
  // naming one we cannot vouch for.
  const filteredAccountName =
    accountId === null ? undefined : accountsById.get(accountId)?.name;
  // Same rule for the category, off the archived-INCLUSIVE index (data/categories):
  // a since-archived category still resolves to its own name, flagged as archived,
  // instead of silently reading as an unfiltered list.
  const filteredCategory = categoryId === null ? undefined : categoryIndex.get(categoryId);
  const filteredCategoryName =
    filteredCategory === undefined
      ? undefined
      : filteredCategory.archived
        ? `${filteredCategory.name} ${t('common.archivedParens')}`
        : filteredCategory.name;
  // The country's name in the UI language for the chip below; '' when there is
  // no country filter and therefore no chip to fill.
  const countryName =
    selection.country === null ? '' : countryLabel(locale, selection.country);
  // Whether the list is showing a narrowed set — drives the upcoming widget.
  const narrowed = isNarrowed(selection);

  return (
    <section className={styles.page}>
      <div className={styles.toolbar}>
        <h1 className={styles.title}>{t('tx.title')}</h1>
        {/* S1 + this scope: THREE range modes, one control slot (month, all time,
            custom period). The picker owns the mode's UI; the page owns the URL. */}
        <TxRangePicker mode={mode} month={month} onChange={setRangeMode} />
        {/* Search, account, and the rest of the filters behind one button: three
            controls in the toolbar, not a permanent filter panel. */}
        <TxSearchField value={selection.q ?? ''} onCommit={setSearch} />
        <AccountFilter
          value={accountId}
          accounts={filterAccounts}
          phase={accountsPhase}
          onChange={setAccount}
        />
        <TxFiltersPopover
          categories={categoriesQuery.data ?? []}
          categoryId={categoryId}
          country={selection.country}
          sort={selection.sort}
          activeCount={activeFilterCount(selection)}
          onCategoryChange={setCategory}
          onCountryChange={setCountry}
          onSortChange={setSort}
          onReset={() =>
            setParams((params) => {
              for (const key of ['category', 'country', 'sort']) params.delete(key);
            })
          }
        />
        {/* Two capture paths side by side: type it in, or photograph it. */}
        <div className={styles.toolbarActions}>
          <button
            type="button"
            className={styles.addButton}
            onClick={() => setModal({ type: 'create' })}
          >
            {t('tx.add')}
          </button>
          <button
            type="button"
            className={styles.transferButton}
            onClick={() => setModal({ type: 'createTransfer' })}
          >
            {t('tx.addTransfer')}
          </button>
          <button
            type="button"
            className={styles.photoButton}
            onClick={() => setModal({ type: 'receipt' })}
          >
            {t('tx.addByPhoto')}
          </button>
          {/* Goes through the api-client like every other call: the bearer travels
              in the header, never a token in a query string or a bare <a href>
              to the API (D13). */}
          <button
            type="button"
            className={styles.exportButton}
            disabled={exportTransactions.isPending}
            onClick={() => {
              void runExport();
            }}
          >
            {t(exportTransactions.isPending ? 'tx.exporting' : 'tx.export')}
          </button>
        </div>
      </div>

      {/* A browser that saves without prompting gives no feedback at all, so the
          success path says so out loud; the failure path is inline next to the
          button with a retry, never a modal. */}
      {exportNote !== null ? (
        <p className={styles.exportNote} role="status">
          {exportNote}
        </p>
      ) : null}
      {exportError !== null ? (
        <p className={styles.exportError} role="alert">
          {exportError}
          <button
            type="button"
            className={styles.exportRetry}
            onClick={() => {
              void runExport();
            }}
          >
            {t('common.retry')}
          </button>
        </p>
      ) : null}

      {/* GET /transactions/summary is a MONTH aggregate and takes no other filter,
          so it has nothing to say about an all-time list — showing one month's
          totals above every transaction ever would read as their sum. A CUSTOM
          period is the same situation for the same reason: the totals would be
          August's above a list of three days in July. The query itself keeps
          running in both: `summary.currency` is the profile base currency the rows
          need for their converted line, and it is one cached request. */}
      {mode.kind === 'month' ? (
        <SummaryHeader summaryQuery={summaryQuery} categoryIndex={categoryIndex} />
      ) : null}

      {/* What the templates still owe in the next 30 days. Deliberately NOT
          month-scoped and not account-scoped — the endpoint takes neither — so it
          is HIDDEN whenever the list below is narrowed by a filter (account,
          category, search or country; `isNarrowed`).

          The rows are TEMPLATES: they have no note and no country, so the widget
          cannot honestly answer a search or a country filter, and a half-filtered
          widget lies. Hiding it on any narrowed set is the one consistent rule —
          and it fixes the S1 defect where the widget silently ignored the account
          filter. `range=all` (a WIDER set) and a mere re-sort keep it on screen. */}
      {/* goal-planner W2: the second widget, under the SAME narrowed gate and for
          the same reason — its rows are PLAN ITEMS, which carry no note, no
          country, no account and no category, so they cannot honestly answer any
          of the filters below. It also renders nothing at all while the endpoint
          is undeployed (TEMPORARY(B2), data/goalDeadlines.ts). */}
      {narrowed ? null : <GoalDeadlines deposits={depositDeadlines} />}

      {narrowed ? null : (
        <UpcomingCharges
          // The TEMPLATE is the richer source (it also carries `merchant` and
          // `note`, which the upcoming endpoint does not return) and this page
          // already holds the template list for the row badges — so this costs no
          // request. The widget row itself is the honest fallback while that list
          // is still loading or failed: same account, amount, currency, kind and
          // category, minus the two fields it does not carry.
          onAdd={(charge) =>
            setModal({
              type: 'createFromTemplate',
              source: recurringIndex.get(charge.template_id) ?? charge,
              occurredAt: charge.due_on,
            })
          }
        />
      )}

      {/* What each filter is doing, in words, right where it stops applying — plus
          ONE caveat line for the summary above, which is a whole-month aggregate
          over every account and category (GET /transactions/summary takes neither
          filter). The caveat is tied to the summary being on screen at all, so
          all-time mode drops it instead of pointing at totals that are not there. */}
      {accountId !== null || categoryId !== null || selection.country !== null ? (
        <div className={styles.filters}>
          {accountId !== null ? (
            <p className={styles.filterChip} role="status">
              {t('tx.filterChip', {
                account: filteredAccountName ?? t('tx.filterOneAccount'),
              })}
              <button
                type="button"
                className={styles.clearFilter}
                onClick={() => setAccount(null)}
              >
                {t('tx.showAllAccounts')}
              </button>
            </p>
          ) : null}
          {categoryId !== null ? (
            <p className={styles.filterChip} role="status">
              {t('tx.filterCategoryChip', {
                category: filteredCategoryName ?? t('tx.filterOneCategory'),
              })}
              <button
                type="button"
                className={styles.clearFilter}
                aria-label={t('tx.clearCategoryFilter')}
                onClick={() => setCategory(null)}
              >
                ×
              </button>
            </p>
          ) : null}
          {/* The search text is not chipped: the box above shows it verbatim and
              clears it. The country code is only visible inside the closed
              popover, so it gets a chip of its own. */}
          {selection.country !== null ? (
            <p className={styles.filterChip} role="status">
              {t('tx.filterCountryChip', { country: countryName })}
              <button
                type="button"
                className={styles.clearFilter}
                aria-label={t('tx.clearCountryFilter')}
                onClick={() => setCountry(null)}
              >
                ×
              </button>
            </p>
          ) : null}
          {mode.kind === 'month' ? (
            <p className={styles.filterNote}>{t('tx.filterSummaryNote')}</p>
          ) : null}
        </div>
      ) : null}

      <TransactionList
        transactions={transactions}
        total={total}
        phase={queryPhase(txQuery)}
        hasMore={txQuery.hasNextPage}
        isLoadingMore={txQuery.isFetchingNextPage}
        periodLabel={periodLabel}
        categoryIndex={categoryIndex}
        summaryCurrency={summaryQuery.data?.currency}
        recurringIndex={recurringIndex}
        accountsById={accountsById}
        // A transfer matches both of its legs server-side, so a filtered list
        // shows it from whichever side this account is on (A3).
        viewAccountId={accountId ?? undefined}
        categoryFiltered={categoryId !== null}
        allTime={allTime}
        otherFiltered={selection.q !== null || selection.country !== null}
        // Day headers only under the date orders (showsDayGroups): grouping an
        // amount-sorted list by day would produce one-row groups in no date order.
        grouped={showsDayGroups(selection.sort)}
        onClearAccountFilter={() => setAccount(null)}
        onClearCategoryFilter={() => setCategory(null)}
        onClearOtherFilters={clearSearchAndFilters}
        onLoadMore={() => txQuery.fetchNextPage()}
        onRetry={() => txQuery.refetch()}
        // One row, one form (A1): a transfer opens the transfer form, where both
        // of its sides are editable together.
        onEdit={(transaction) =>
          setModal(
            transaction.kind === 'transfer'
              ? { type: 'editTransfer', transfer: transaction }
              : { type: 'edit', transaction },
          )
        }
        onAddFirst={() => setModal({ type: 'create' })}
      />

      {modal.type === 'create' ? (
        <TransactionFormModal
          month={month}
          categories={categoriesQuery.data ?? []}
          onClose={() => setModal({ type: 'closed' })}
        />
      ) : null}
      {modal.type === 'createFromTemplate' ? (
        <TransactionFormModal
          month={month}
          categories={categoriesQuery.data ?? []}
          templatePrefill={{ source: modal.source, occurredAt: modal.occurredAt }}
          onClose={() => setModal({ type: 'closed' })}
        />
      ) : null}
      {modal.type === 'receipt' ? (
        <ReceiptCaptureModal
          month={month}
          categories={categoriesQuery.data ?? []}
          onClose={() => setModal({ type: 'closed' })}
        />
      ) : null}
      {modal.type === 'edit' ? (
        <TransactionFormModal
          key={modal.transaction.id}
          month={month}
          transaction={modal.transaction}
          categories={categoriesQuery.data ?? []}
          onClose={() => setModal({ type: 'closed' })}
        />
      ) : null}
      {modal.type === 'createTransfer' ? (
        <TransferFormModal onClose={() => setModal({ type: 'closed' })} />
      ) : null}
      {modal.type === 'editTransfer' ? (
        <TransferFormModal
          key={modal.transfer.id}
          transfer={modal.transfer}
          onClose={() => setModal({ type: 'closed' })}
        />
      ) : null}
    </section>
  );
}
