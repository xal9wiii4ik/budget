import { currentMonth, formatMonthLabel, monthBounds } from '@budget/shared';
import type { components } from '@budget/api-client';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';

import { useAccounts } from '../data/accounts';
import { buildCategoryIndex } from '../data/categoryLookup';
import { useCategories } from '../data/categories';
import { useRecurringTemplates, type RecurringTemplateRead } from '../data/recurring';
import {
  useExportTransactions,
  useSummary,
  useTransactions,
  type ExportFilters,
} from '../data/transactions';
import type { TxListFilters } from '../data/queryKeys';
import { downloadBlob } from '../lib/download';
import { useLang, useLocale, useT } from '../i18n/context';
import { describeExportError } from '../lib/errors';
import { queryPhase } from '../lib/queryPhase';
import { AccountFilter } from '../features/accounts/AccountFilter';
import { accountIndex } from '../features/accounts/accountOptions';
import { ReceiptCaptureModal } from '../features/receipts/ReceiptCaptureModal';
import { UpcomingCharges } from '../features/recurring/UpcomingCharges';
import { TransferFormModal } from '../features/transfers/TransferFormModal';
import { MonthPicker } from '../features/transactions/MonthPicker';
import { SummaryHeader } from '../features/transactions/SummaryHeader';
import { TransactionFormModal } from '../features/transactions/TransactionFormModal';
import type { TemplatePrefillSource } from '../features/transactions/templatePrefill';
import { TransactionList } from '../features/transactions/TransactionList';
import styles from './TransactionsPage.module.css';

type TransactionRead = components['schemas']['TransactionRead'];

// R4: fetch the whole month slice at limit=200; "Load more" only if total exceeds it.
const MONTH_LIMIT = 200;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
// `?account=` / `?category=` are URL parameters anyone can type. The server
// declares both filters as UUIDs, so a junk value would come back as a 422 the
// list has no field to show it on; an unparseable id is treated as no filter.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const monthParam = searchParams.get('month');
  const month = monthParam && MONTH_PATTERN.test(monthParam) ? monthParam : currentMonth();

  const accountParam = searchParams.get('account');
  const accountId = accountParam && UUID_PATTERN.test(accountParam) ? accountParam : null;

  // S1: the drill-down from /categories. Read exactly like `?account=` above —
  // same UUID gate, junk means "no filter" rather than a 422 with nowhere to land.
  const categoryParam = searchParams.get('category');
  const categoryId = categoryParam && UUID_PATTERN.test(categoryParam) ? categoryParam : null;

  // S1: "all time" is a URL FLAG, not a date-range picker (deliberately deferred).
  // Any other value of `range` is the month mode, so a typo cannot strand the user
  // in a window they did not ask for.
  const allTime = searchParams.get('range') === 'all';

  // Each filter member is OMITTED, not set to undefined, when nothing is filtered:
  // the unfiltered month keeps exactly the cache key it had before these filters
  // existed, and every filtered variant is its own entry (data/queryKeys.ts).
  // In all-time mode from/to leave too — the server takes both as optional, so
  // "the whole history" needs no endpoint of its own.
  const filters: TxListFilters = {
    ...(allTime ? {} : monthBounds(month)),
    ...(categoryId === null ? {} : { category_id: categoryId }),
    ...(accountId === null ? {} : { account_id: accountId }),
    limit: MONTH_LIMIT,
  };

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

  const categoryIndex = useMemo(
    () => buildCategoryIndex(categoriesQuery.data ?? []),
    [categoriesQuery.data],
  );

  const accountsById = useMemo(
    () => accountIndex(accountsQuery.data ?? []),
    [accountsQuery.data],
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
    const query: ExportFilters = {
      from: filters.from,
      to: filters.to,
      category_id: filters.category_id,
      kind: filters.kind,
      // OQ-W3: the export takes the SAME account filter as the list (the server
      // accepts it on /transactions/export since B2), so the file is what was on
      // screen and not the whole month.
      account_id: filters.account_id,
    };
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
  const setParam = (key: string, next: string | null) => {
    // The export confirmation names a file for the slice it exported; keeping it
    // on screen after the month or the account filter changes would read as a
    // claim about the new one.
    setExportNote(null);
    setExportError(null);
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      if (next === null) params.delete(key);
      else params.set(key, next);
      return params;
    });
  };

  const setMonth = (next: string) => setParam('month', next);
  const setAccount = (next: string | null) => setParam('account', next);
  const setCategory = (next: string | null) => setParam('category', next);
  // The month parameter is deliberately LEFT in the URL while all-time is on:
  // turning it back off returns to the month the user was reading, not to today.
  const setAllTime = (next: boolean) => setParam('range', next ? 'all' : null);

  const transactions = txQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const total = txQuery.data?.pages[0]?.total ?? 0;
  // Follows the CHOSEN language, not the host locale.
  const monthLabel = formatMonthLabel(month, { locale });
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

  return (
    <section className={styles.page}>
      <div className={styles.toolbar}>
        <h1 className={styles.title}>{t('tx.title')}</h1>
        {/* S1: two range modes, one control slot. In all-time mode the stepper is
            gone (there is no month to step) and its place says what is on screen,
            next to the way back — a stepper that quietly did nothing would be the
            worse lie. */}
        {allTime ? (
          <div className={styles.range}>
            <span className={styles.rangeLabel}>{t('tx.rangeAllTime')}</span>
            <button
              type="button"
              className={styles.rangeButton}
              onClick={() => setAllTime(false)}
            >
              {t('tx.rangeBackToMonth')}
            </button>
          </div>
        ) : (
          <div className={styles.range}>
            <MonthPicker month={month} onChange={setMonth} />
            <button
              type="button"
              className={styles.rangeButton}
              onClick={() => setAllTime(true)}
            >
              {t('tx.rangeShowAllTime')}
            </button>
          </div>
        )}
        <AccountFilter
          value={accountId}
          accounts={accountsQuery.data ?? []}
          phase={accountsPhase}
          onChange={setAccount}
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
          totals above every transaction ever would read as their sum. The query
          itself keeps running: `summary.currency` is the profile base currency the
          rows need for their converted line, and it is one cached request. */}
      {allTime ? null : (
        <SummaryHeader summaryQuery={summaryQuery} categoryIndex={categoryIndex} />
      )}

      {/* What the templates still owe in the next 30 days. Deliberately NOT
          month-scoped and not account-scoped (the endpoint takes neither), so it
          sits below the month summary and says so in its own copy. */}
      <UpcomingCharges
        accountFiltered={accountId !== null}
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

      {/* What each filter is doing, in words, right where it stops applying — plus
          ONE caveat line for the summary above, which is a whole-month aggregate
          over every account and category (GET /transactions/summary takes neither
          filter). The caveat is tied to the summary being on screen at all, so
          all-time mode drops it instead of pointing at totals that are not there. */}
      {accountId !== null || categoryId !== null ? (
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
          {allTime ? null : (
            <p className={styles.filterNote}>{t('tx.filterSummaryNote')}</p>
          )}
        </div>
      ) : null}

      <TransactionList
        transactions={transactions}
        total={total}
        phase={queryPhase(txQuery)}
        hasMore={txQuery.hasNextPage}
        isLoadingMore={txQuery.isFetchingNextPage}
        monthLabel={monthLabel}
        categoryIndex={categoryIndex}
        summaryCurrency={summaryQuery.data?.currency}
        recurringIndex={recurringIndex}
        accountsById={accountsById}
        // A transfer matches both of its legs server-side, so a filtered list
        // shows it from whichever side this account is on (A3).
        viewAccountId={accountId ?? undefined}
        categoryFiltered={categoryId !== null}
        allTime={allTime}
        onClearAccountFilter={() => setAccount(null)}
        onClearCategoryFilter={() => setCategory(null)}
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
