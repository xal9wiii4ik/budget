import { currentMonth, formatMonthLabel, monthBounds } from '@budget/shared';
import type { components } from '@budget/api-client';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';

import { buildCategoryIndex } from '../data/categoryLookup';
import { useCategories } from '../data/categories';
import {
  useExportTransactions,
  useSummary,
  useTransactions,
  type ExportFilters,
} from '../data/transactions';
import type { TxListFilters } from '../data/queryKeys';
import { downloadBlob } from '../lib/download';
import { describeExportError } from '../lib/errors';
import { ReceiptCaptureModal } from '../features/receipts/ReceiptCaptureModal';
import { MonthPicker } from '../features/transactions/MonthPicker';
import { SummaryHeader } from '../features/transactions/SummaryHeader';
import { TransactionFormModal } from '../features/transactions/TransactionFormModal';
import { TransactionList } from '../features/transactions/TransactionList';
import styles from './TransactionsPage.module.css';

type TransactionRead = components['schemas']['TransactionRead'];

// R4: fetch the whole month slice at limit=200; "Load more" only if total exceeds it.
const MONTH_LIMIT = 200;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * The saved filename, built client-side (4.5 W4). The server sends a CONSTANT
 * `Content-Disposition` name, so three exports in a row would overwrite each
 * other in the Downloads folder; naming by what was exported fixes that.
 * Presentation only — no contract implication.
 */
function exportFilename(filters: ExportFilters, month: string): string {
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
  // S5: ONE variant for the whole photo flow — the capture modal swaps its own
  // body to the transaction form when the flow gets there (R6).
  | { type: 'receipt' };

export function TransactionsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const monthParam = searchParams.get('month');
  const month = monthParam && MONTH_PATTERN.test(monthParam) ? monthParam : currentMonth();

  const bounds = monthBounds(month);
  const filters: TxListFilters = { from: bounds.from, to: bounds.to, limit: MONTH_LIMIT };

  const txQuery = useTransactions(filters);
  const summaryQuery = useSummary(month);
  const categoriesQuery = useCategories();

  const categoryIndex = useMemo(
    () => buildCategoryIndex(categoriesQuery.data ?? []),
    [categoriesQuery.data],
  );

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
    };
    setExportNote(null);
    setExportError(null);
    let blob: Blob;
    try {
      blob = await exportTransactions.mutateAsync(query);
    } catch (error) {
      setExportError(describeExportError(error));
      return;
    }
    const filename = exportFilename(query, month);
    downloadBlob(blob, filename);
    // The peek is only about WORDING: once the file is saved the export
    // succeeded, so a failed peek must never surface as a failed export.
    const headerOnly = await isHeaderOnly(blob).catch(() => false);
    setExportNote(
      headerOnly
        ? `Downloaded ${filename} — no transactions matched, so it has headers only.`
        : `Downloaded ${filename}.`,
    );
  };

  const setMonth = (next: string) => {
    // The export confirmation names a file for the month it exported; keeping it
    // on screen after the month changes would read as a claim about the new one.
    setExportNote(null);
    setExportError(null);
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      params.set('month', next);
      return params;
    });
  };

  const transactions = txQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const total = txQuery.data?.pages[0]?.total ?? 0;
  const monthLabel = formatMonthLabel(month);

  return (
    <section className={styles.page}>
      <div className={styles.toolbar}>
        <h1 className={styles.title}>Transactions</h1>
        <MonthPicker month={month} onChange={setMonth} />
        {/* Two capture paths side by side: type it in, or photograph it. */}
        <div className={styles.toolbarActions}>
          <button
            type="button"
            className={styles.addButton}
            onClick={() => setModal({ type: 'create' })}
          >
            Add transaction
          </button>
          <button
            type="button"
            className={styles.photoButton}
            onClick={() => setModal({ type: 'receipt' })}
          >
            Add by photo
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
            {exportTransactions.isPending ? 'Exporting…' : 'Export CSV'}
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
            Retry
          </button>
        </p>
      ) : null}

      <SummaryHeader summaryQuery={summaryQuery} categoryIndex={categoryIndex} />

      <TransactionList
        transactions={transactions}
        total={total}
        status={txQuery.status}
        hasMore={txQuery.hasNextPage}
        isLoadingMore={txQuery.isFetchingNextPage}
        monthLabel={monthLabel}
        categoryIndex={categoryIndex}
        summaryCurrency={summaryQuery.data?.currency}
        onLoadMore={() => txQuery.fetchNextPage()}
        onRetry={() => txQuery.refetch()}
        onEdit={(transaction) => setModal({ type: 'edit', transaction })}
        onAddFirst={() => setModal({ type: 'create' })}
      />

      {modal.type === 'create' ? (
        <TransactionFormModal
          month={month}
          categories={categoriesQuery.data ?? []}
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
    </section>
  );
}
