import type { components } from '@budget/api-client';

import { QueryStateNotice } from '../../components/QueryStateNotice';
import type { StatementRowDecision, StatementRowRead } from '../../data/imports';
import { useT } from '../../i18n/context';
import type { QueryPhase } from '../../lib/queryPhase';
import { ImportRow } from './ImportRow';
import styles from './ImportRowList.module.css';

type CategoryRead = components['schemas']['CategoryRead'];

interface ImportRowListProps {
  rows: StatementRowRead[];
  phase: QueryPhase;
  hasMore: boolean;
  isLoadingMore: boolean;
  /** True when a status chip is on — the empty state says so instead of lying. */
  filtered: boolean;
  readOnly: boolean;
  categoriesById: Map<string, CategoryRead>;
  pendingRowId: string | null;
  failedRowId: string | null;
  rowErrorMessage: string | null;
  onDecide: (rowId: string, decision: StatementRowDecision) => void;
  onPickCategory: (row: StatementRowRead) => void;
  onLoadMore: () => void;
  onRetry: () => void;
}

/**
 * The preview list: pages of 200, in FILE order, with a "load more" button
 * rather than a scroll listener (the transactions list precedent — an explicit
 * control keeps the user's place, which is exactly what a thousand-row statement
 * must not lose).
 *
 * No virtualization: the pages are the throttle, and the server refuses more
 * than 200 rows at a time.
 */
export function ImportRowList({
  rows,
  phase,
  hasMore,
  isLoadingMore,
  filtered,
  readOnly,
  categoriesById,
  pendingRowId,
  failedRowId,
  rowErrorMessage,
  onDecide,
  onPickCategory,
  onLoadMore,
  onRetry,
}: ImportRowListProps) {
  const t = useT();

  if (phase === 'loading') {
    return (
      <div className={styles.skeletons} aria-hidden="true">
        <div className={styles.skeletonRow} />
        <div className={styles.skeletonRow} />
        <div className={styles.skeletonRow} />
        <div className={styles.skeletonRow} />
      </div>
    );
  }

  if (phase === 'error' || phase === 'unreachable') {
    return (
      <QueryStateNotice phase={phase} message={t('imports.rowsLoadFailed')} onRetry={onRetry} />
    );
  }

  if (rows.length === 0) {
    return (
      <p className={styles.empty}>
        {filtered ? t('imports.rowsEmptyFiltered') : t('imports.rowsEmpty')}
      </p>
    );
  }

  return (
    <div className={styles.list}>
      <ul className={styles.rows}>
        {rows.map((row) => (
          <li key={row.id}>
            <ImportRow
              row={row}
              categoriesById={categoriesById}
              pending={pendingRowId === row.id}
              errorMessage={failedRowId === row.id ? rowErrorMessage : null}
              readOnly={readOnly}
              onDecide={onDecide}
              onPickCategory={onPickCategory}
            />
          </li>
        ))}
      </ul>
      {hasMore ? (
        <button
          type="button"
          className={styles.loadMore}
          onClick={onLoadMore}
          disabled={isLoadingMore}
        >
          {isLoadingMore ? t('common.loading') : t('common.loadMore')}
        </button>
      ) : null}
    </div>
  );
}
