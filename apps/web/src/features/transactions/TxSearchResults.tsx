import type { components } from '@budget/api-client';

import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { QueryStateNotice } from '../../components/QueryStateNotice';
import type { TransactionSearchRead } from '../../data/txSearch';
import { useT } from '../../i18n/context';
import type { SearchFailure } from '../../lib/errors';
import type { QueryPhase } from '../../lib/queryPhase';
import type { NamedAccount } from '../accounts/accountOptions';
import { TransactionRow } from './TransactionRow';
import { roundScore, TX_SEARCH_LIMIT_MORE } from './txSearchMode';
import listStyles from './TransactionList.module.css';
import styles from './TxSearchResults.module.css';

type CategoryRead = components['schemas']['CategoryRead'];
type TransactionRead = components['schemas']['TransactionRead'];

interface TxSearchResultsProps {
  /** The search query's phase; all four arms are rendered. */
  phase: QueryPhase;
  /** Whether a phrase has been committed at all (`?q=` is set). */
  hasQuery: boolean;
  data: TransactionSearchRead | undefined;
  /** The described failure, or null while nothing has failed. */
  failure: SearchFailure | null;
  /** How many hits the request in flight asked for (20, or 50 after "show more"). */
  limit: number;
  /** A refetch is in flight — the "show more" button must not be pressed twice. */
  isFetching: boolean;
  onMore: () => void;
  onRetry: () => void;
  /** Leaves the meaning mode KEEPING the phrase — the way out of every dead end. */
  onToText: () => void;
  onClearFilters: () => void;
  // --- everything below is row rendering, identical to TransactionList's ---
  categoryIndex: Map<string, CategoryRead>;
  summaryCurrency: string | undefined;
  recurringIndex: Map<string, { name: string }>;
  accountsById: Map<string, NamedAccount>;
  debtIndex: Map<string, string>;
  viewAccountId?: string;
  onEdit?: (transaction: TransactionRead) => void;
}

/**
 * The results of a search BY MEANING (rag Web A).
 *
 * The rows go through the SAME `TransactionRow` as the ordinary list, on
 * purpose: which amount leads on a foreign purchase, how a transfer reads, what
 * a debt movement links to — those are decisions about money and a search result
 * must not hold a second opinion about any of them. What this component adds is
 * everything the ranking itself owes the reader: a count, ONE note saying the
 * closeness figures are relative, a quiet per-row score, the honest "some rows
 * are not indexed yet" line, and a top-k footer that does not pretend to be a
 * complete list.
 *
 * The SERVER total is deliberately NOT here — it sits where the month summary
 * sits, which is the only place it cannot be mistaken for a row-level figure
 * (routes/TransactionsPage.tsx renders `SearchTotals` in that slot).
 */
export function TxSearchResults({
  phase,
  hasQuery,
  data,
  failure,
  limit,
  isFetching,
  onMore,
  onRetry,
  onToText,
  onClearFilters,
  categoryIndex,
  summaryCurrency,
  recurringIndex,
  accountsById,
  debtIndex,
  viewAccountId,
  onEdit,
}: TxSearchResultsProps) {
  const t = useT();

  // The mode is on, nothing has been asked yet. A real state and the one that
  // must cost nothing: turning the toggle on sends no request, so the screen has
  // to say what to do rather than show an empty list that looks like an answer.
  if (!hasQuery) {
    return <EmptyState title={t('tx.searchIdle')} description={t('tx.searchIdleCta')} />;
  }

  if (phase === 'loading') {
    // The list's own skeleton, at the list's own height: the point of a
    // placeholder is that nothing jumps when the rows arrive.
    return (
      <Card size="none" className={listStyles.skeletons} aria-hidden="true">
        <div className={listStyles.skeletonRow} />
        <div className={listStyles.skeletonRow} />
        <div className={listStyles.skeletonRow} />
        <div className={listStyles.skeletonRow} />
      </Card>
    );
  }

  // The 503 arm gets a panel of its own rather than an alert with a Retry: this
  // server has no model artifact, so retrying can only produce the same 503. The
  // toggle above stays exactly where it is — the mode is never pre-disabled from
  // a guess, the server's answer is what decides (the `ai_available` precedent)
  // — and the one useful action is the word search, which still works.
  if (failure?.kind === 'embeddings-off') {
    return (
      <EmptyState
        title={t('tx.searchUnavailable')}
        description={failure.message}
        actions={
          <Button variant="primary" onClick={onToText}>
            {t('tx.searchToText')}
          </Button>
        }
      />
    );
  }

  if (phase === 'error' || phase === 'unreachable') {
    return (
      <QueryStateNotice
        phase={phase}
        message={failure?.message ?? t('tx.searchLoadFailed')}
        onRetry={onRetry}
      >
        {/* A second way out beside Retry: a rate limit or a flaky provider is a
            reason to use the other search, not to sit and wait. */}
        <Button size="sm" onClick={onToText}>
          {t('tx.searchToText')}
        </Button>
      </QueryStateNotice>
    );
  }

  // `ready` without a body cannot happen through TanStack (success implies
  // data), but the type says it can — and inventing an empty answer would be a
  // lie about a search that was never run.
  if (data === undefined) {
    return <EmptyState title={t('tx.searchIdle')} description={t('tx.searchIdleCta')} />;
  }

  const hits = data.items;

  if (hits.length === 0) {
    return (
      <EmptyState
        title={t('tx.searchEmpty')}
        // What to do next, including the one thing a user cannot guess: transfers
        // and debt movements are not in the indexed population at all (D-T4), so
        // no wording of a phrase will ever find them here.
        description={t('tx.searchEmptyCta')}
        actions={
          <>
            <Button variant="primary" onClick={onToText}>
              {t('tx.searchToText')}
            </Button>
            <Button onClick={onClearFilters}>{t('tx.emptyClearFilters')}</Button>
          </>
        }
      />
    );
  }

  // A full page of hits is the ONLY evidence that the ranking was cut off. A
  // result shorter than the limit IS everything that matched the filters, so it
  // must not be told it is a top-k (web-qa NIT-2) and there is nothing larger to
  // ask for either — the route has no pagination, so "show more" is a SECOND
  // complete search at 50.
  const isTruncated = hits.length >= limit;
  const canAskMore = limit < TX_SEARCH_LIMIT_MORE && isTruncated;

  return (
    <div className={listStyles.list}>
      <div className={styles.header}>
        <p className={styles.count}>{t('tx.searchResults', { count: hits.length })}</p>
        {/* ONCE per list, never per row: the figures mean something only next to
            each other, and repeating that under every badge would turn an
            honesty note into noise. A standing fact about the scale, so no
            `role="status"` — it is not news (the `aiStatusLine` rule). */}
        <p className={styles.scoreNote}>{t('tx.searchScoreNote')}</p>
      </div>

      {/* ASK-6: a user-wide count taken AFTER the search re-indexed what it
          could, so the sentence is about these results and not about a month or
          a filter. News, and quiet: one line with `role="status"`, never a
          banner and never a block on reading what did arrive. */}
      {data.pending_count > 0 ? (
        <p className={styles.pending} role="status">
          {t('tx.searchPending', { count: data.pending_count })}
        </p>
      ) : null}

      <Card size="none">
        <ul className={listStyles.rows}>
          {hits.map((hit) => (
            <li key={hit.transaction.id} className={styles.hit}>
              <TransactionRow
                transaction={hit.transaction}
                category={
                  hit.transaction.category_id
                    ? categoryIndex.get(hit.transaction.category_id)
                    : undefined
                }
                summaryCurrency={summaryCurrency}
                recurringIndex={recurringIndex}
                accountsById={accountsById}
                debtIndex={debtIndex}
                viewAccountId={viewAccountId}
                // Ranked by closeness, not by day, so the list has no day
                // headers and each row states its own date.
                showDate
                onEdit={onEdit}
              />
              {/* OUTSIDE the row element on purpose: the row is a <button>, and
                  nothing may nest inside it that a screen reader would read as
                  part of its label. Muted, tabular, two decimals — never a
                  percentage and never a bar (D-R3). */}
              <p className={styles.scoreLine}>
                <Badge className={styles.scoreBadge}>
                  <span className="tnum" aria-hidden="true">
                    {t('tx.searchScore', { score: roundScore(hit.score) })}
                  </span>
                  {/* A bare "0.83" is not a sentence; the spelled-out version is
                      what a screen reader gets. */}
                  <span className="srOnly">
                    {t('tx.searchScoreAria', { score: roundScore(hit.score) })}
                  </span>
                </Badge>
              </p>
            </li>
          ))}
        </ul>
      </Card>

      {/* Only a CUT-OFF list has a footer: the sentence is the claim a top-k must
          never make silently, and `canAskMore` implies `isTruncated`, so a short
          answer renders no empty row at all. */}
      {isTruncated ? (
        <div className={listStyles.footer}>
          <span className={listStyles.count}>{t('tx.searchShowing', { count: hits.length })}</span>
          {canAskMore ? (
            <Button onClick={onMore} disabled={isFetching}>
              {t(isFetching ? 'common.loading' : 'tx.searchMore')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
