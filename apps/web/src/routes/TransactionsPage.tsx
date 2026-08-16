import { currentMonth, formatMonthLabel, monthBounds } from '@budget/shared';
import type { components } from '@budget/api-client';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';

import { buildCategoryIndex } from '../data/categoryLookup';
import { useCategories } from '../data/categories';
import { useSummary, useTransactions } from '../data/transactions';
import type { TxListFilters } from '../data/queryKeys';
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

  const setMonth = (next: string) => {
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
        </div>
      </div>

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
