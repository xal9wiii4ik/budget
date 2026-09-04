import { formatApiDate } from '@budget/shared';
import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { Button } from '../components/Button';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { QueryStateNotice } from '../components/QueryStateNotice';
import { useAccounts } from '../data/accounts';
import { useCategories } from '../data/categories';
import { buildCategoryIndex } from '../data/categoryLookup';
import {
  useApplyImport,
  useBulkDecideImportRows,
  useCancelImport,
  useImportRows,
  useImportSession,
  usePatchImportRow,
  type StatementRowDecision,
  type StatementRowMatchStatus,
  type StatementRowRead,
} from '../data/imports';
import { CategoryPickerModal } from '../features/imports/CategoryPickerModal';
import { ImportFilterBar } from '../features/imports/ImportFilterBar';
import { ImportReport, type ImportReportData } from '../features/imports/ImportReport';
import { ImportRowList } from '../features/imports/ImportRowList';
import { ReplaceFlow } from '../features/imports/ReplaceFlow';
import { txWindowHref } from '../features/transactions/txWindow';
import { useLang, useLocale, useT } from '../i18n/context';
import { describeImportError } from '../lib/errors';
import { queryPhase } from '../lib/queryPhase';
import styles from './ImportPage.module.css';

type ModalState =
  | { type: 'closed' }
  | { type: 'category'; row: StatementRowRead }
  | { type: 'apply' }
  | { type: 'replace' }
  | { type: 'cancel' };

/**
 * One import session: what the statement says, what we already have, and what
 * will happen to each line.
 *
 * Deep-linkable and F5-proof by construction — everything on it is read from
 * `GET /{id}` and `GET /{id}/rows`, and the only things that live in component
 * state are the status chip, the open dialog and the LAST REPORT (which exists
 * nowhere else: apply/replace return it in the response body and the server
 * keeps no copy, §10.6).
 *
 * No money is computed here. The counters come from the session, the per-line
 * amounts from the rows, and the report from the response — this screen adds
 * nothing up.
 */
export function ImportPage() {
  const t = useT();
  const lang = useLang();
  const locale = useLocale();
  const navigate = useNavigate();
  const { importId = '' } = useParams();

  const [matchStatus, setMatchStatus] = useState<StatementRowMatchStatus | null>(null);
  const [modal, setModal] = useState<ModalState>({ type: 'closed' });
  const [report, setReport] = useState<ImportReportData | null>(null);

  const sessionQuery = useImportSession(importId);
  const rowsQuery = useImportRows(importId, matchStatus);
  const categoriesQuery = useCategories();
  const accountsQuery = useAccounts();

  const patchRow = usePatchImportRow(importId);
  const bulkDecide = useBulkDecideImportRows(importId);
  const applyImport = useApplyImport(importId);
  const cancelImport = useCancelImport();

  const sessionPhase = queryPhase(sessionQuery);
  const session = sessionQuery.data;
  const readOnly = session !== undefined && session.status !== 'parsed';
  const rows = rowsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const account = accountsQuery.data?.find((item) => item.id === session?.account_id);

  // The three things a memoized row receives must keep their identity between
  // renders, or the memo is decoration: a rebuilt Map or a fresh callback would
  // re-render all thousand rows on every keystroke and every mutation tick.
  // `mutate` is stable in TanStack Query v5; the mutation OBJECT is not, which
  // is why the dependency is the function and not the result.
  const categories = categoriesQuery.data;
  const categoriesById = useMemo(() => buildCategoryIndex(categories ?? []), [categories]);
  const patchMutate = patchRow.mutate;
  const onDecide = useCallback(
    (rowId: string, decision: StatementRowDecision) => {
      patchMutate({ rowId, body: { decision } });
    },
    [patchMutate],
  );
  const onPickCategory = useCallback((row: StatementRowRead) => {
    setModal({ type: 'category', row });
  }, []);

  const rowFailure =
    patchRow.error === null ? null : describeImportError(patchRow.error, lang);
  const pendingRowId = patchRow.isPending ? (patchRow.variables?.rowId ?? null) : null;
  const failedRowId = rowFailure === null ? null : (patchRow.variables?.rowId ?? null);

  if (sessionPhase === 'loading') {
    return (
      <section className={styles.page}>
        <div className={styles.skeletonHeader} aria-hidden="true" />
        <div className={styles.skeletonHeader} aria-hidden="true" />
      </section>
    );
  }

  if (sessionPhase === 'error' || sessionPhase === 'unreachable') {
    return (
      <section className={styles.page}>
        <QueryStateNotice
          phase={sessionPhase}
          message={
            sessionPhase === 'error'
              ? describeImportError(sessionQuery.error, lang).message
              : t('imports.loadFailed')
          }
          onRetry={() => {
            void sessionQuery.refetch();
          }}
        >
          <Link className={styles.headerLink} to="/accounts">
            {t('imports.backToAccounts')}
          </Link>
        </QueryStateNotice>
      </section>
    );
  }

  if (session === undefined) return null;

  const transactionsHref = txWindowHref(
    { kind: 'account', accountId: session.account_id },
    { kind: 'custom', from: session.period_from, to: session.period_to },
  );
  // The apply confirmation is built from the DECISION cross-section (§10.4) —
  // what will happen, not what was found — and each clause is said only when it
  // is true, so the dialog never claims "replace 0 of my records".
  const decisionClauses = [
    session.by_decision.import > 0
      ? t('imports.applyCreate', { count: session.by_decision.import })
      : null,
    session.by_decision.skip > 0
      ? t('imports.applySkip', { count: session.by_decision.skip })
      : null,
    session.by_decision.replace_own > 0
      ? t('imports.applyReplace', { count: session.by_decision.replace_own })
      : null,
  ].filter((clause): clause is string => clause !== null);

  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1>{t('imports.title')}</h1>
          <p className={styles.subtitle}>
            {session.filename}
            {account === undefined ? '' : ` · ${account.name}`} · {session.statement_currency}
          </p>
          <p className={styles.period}>
            {t('imports.period', {
              from: formatApiDate(session.period_from, { locale }),
              to: formatApiDate(session.period_to, { locale }),
            })}
          </p>
        </div>
        <Link className={styles.headerLink} to="/accounts">
          {t('imports.backToAccounts')}
        </Link>
      </header>

      <ul className={styles.counters}>
        <li>{t('imports.rowsTotal', { count: session.rows_total })}</li>
        {/* Said even at zero? No — an absent line is the honest rendering of
            "the file had none", and these two exist to explain a MISSING row. */}
        {session.rows_blocked > 0 ? (
          <li>{t('imports.rowsBlocked', { count: session.rows_blocked })}</li>
        ) : null}
        {session.rows_zero_skipped > 0 ? (
          <li>{t('imports.rowsZeroSkipped', { count: session.rows_zero_skipped })}</li>
        ) : null}
      </ul>

      {report === null ? null : (
        <ImportReport data={report} transactionsHref={transactionsHref} />
      )}

      {readOnly ? (
        <p className={styles.finished} role="status">
          {t('imports.finishedLede')}{' '}
          <Link className={styles.headerLink} to={transactionsHref}>
            {t('imports.openTransactions')}
          </Link>
        </p>
      ) : null}

      <ImportFilterBar
        matchStatus={matchStatus}
        counts={session.by_match_status}
        total={session.rows_total}
        readOnly={readOnly}
        isBulkPending={bulkDecide.isPending}
        bulkErrorMessage={
          bulkDecide.error === null ? null : describeImportError(bulkDecide.error, lang).message
        }
        onChange={setMatchStatus}
        onBulkDecide={(decision) =>
          matchStatus === null
            ? undefined
            : bulkDecide.mutate({ match_status: matchStatus, decision })
        }
      />

      <ImportRowList
        rows={rows}
        phase={queryPhase(rowsQuery)}
        hasMore={rowsQuery.hasNextPage}
        isLoadingMore={rowsQuery.isFetchingNextPage}
        filtered={matchStatus !== null}
        readOnly={readOnly}
        categoriesById={categoriesById}
        pendingRowId={pendingRowId}
        failedRowId={failedRowId}
        rowErrorMessage={rowFailure?.message ?? null}
        onDecide={onDecide}
        onPickCategory={onPickCategory}
        onLoadMore={() => {
          void rowsQuery.fetchNextPage();
        }}
        onRetry={() => {
          void rowsQuery.refetch();
        }}
      />

      {readOnly ? null : (
        <footer className={styles.footer}>
          <Button variant="primary" onClick={() => setModal({ type: 'apply' })}>
            {t('imports.apply')}
          </Button>
          <Button onClick={() => setModal({ type: 'replace' })}>{t('imports.replace')}</Button>
          <Button
            className={styles.cancelAction}
            onClick={() => setModal({ type: 'cancel' })}
          >
            {t('imports.cancel')}
          </Button>
        </footer>
      )}

      {modal.type === 'category' ? (
        <CategoryPickerModal
          categories={categories ?? []}
          currentId={modal.row.category_id}
          rowDescription={modal.row.description}
          isPending={patchRow.isPending}
          errorMessage={rowFailure?.message ?? null}
          onPick={(categoryId) => {
            patchMutate(
              { rowId: modal.row.id, body: { category_id: categoryId } },
              { onSuccess: () => setModal({ type: 'closed' }) },
            );
          }}
          onClose={() => setModal({ type: 'closed' })}
        />
      ) : null}

      {modal.type === 'apply' ? (
        <ConfirmDialog
          title={t('imports.applyTitle')}
          message={
            decisionClauses.length === 0
              ? t('imports.applyNothing')
              : `${decisionClauses.join(' ')} ${t('imports.applyIrreversibleNote')}`
          }
          confirmLabel={t('imports.applyConfirm')}
          pendingLabel={t('imports.applyPending')}
          isPending={applyImport.isPending}
          errorMessage={
            applyImport.error === null
              ? undefined
              : describeImportError(applyImport.error, lang).message
          }
          onConfirm={() => {
            applyImport.mutate(undefined, {
              onSuccess: (result) => {
                setReport({ kind: 'apply', report: result });
                setModal({ type: 'closed' });
              },
            });
          }}
          onCancel={() => setModal({ type: 'closed' })}
        />
      ) : null}

      {modal.type === 'cancel' ? (
        <ConfirmDialog
          title={t('imports.cancelTitle')}
          message={t('imports.cancelMessage')}
          confirmLabel={t('imports.cancelConfirm')}
          pendingLabel={t('common.deleting')}
          destructive
          isPending={cancelImport.isPending}
          errorMessage={
            cancelImport.error === null
              ? undefined
              : describeImportError(cancelImport.error, lang).message
          }
          onConfirm={() => {
            cancelImport.mutate(importId, {
              onSuccess: () => {
                void navigate('/accounts');
              },
            });
          }}
          onCancel={() => setModal({ type: 'closed' })}
        />
      ) : null}

      {modal.type === 'replace' ? (
        <ReplaceFlow
          importId={importId}
          periodFrom={session.period_from}
          periodTo={session.period_to}
          onClose={() => setModal({ type: 'closed' })}
          onReplaced={(result) => {
            setReport({ kind: 'replace', report: result });
            setModal({ type: 'closed' });
          }}
        />
      ) : null}
    </section>
  );
}
