import type { components } from '@budget/api-client';

import type { StatementRowDecision, StatementRowMatchStatus } from '../../data/imports';
import { useT } from '../../i18n/context';
import styles from './ImportFilterBar.module.css';

type MatchStatusCounts = components['schemas']['MatchStatusCounts'];

interface ImportFilterBarProps {
  matchStatus: StatementRowMatchStatus | null;
  /** The session's `by_match_status` — server counters, never counted here. */
  counts: MatchStatusCounts;
  /** `rows_total`: the "all" chip is not the sum of the other three, it is a field. */
  total: number;
  readOnly: boolean;
  isBulkPending: boolean;
  bulkErrorMessage: string | null;
  onChange: (status: StatementRowMatchStatus | null) => void;
  onBulkDecide: (decision: StatementRowDecision) => void;
}

const FILTERS: readonly (StatementRowMatchStatus | null)[] = [null, 'similar', 'new', 'exact'];

const FILTER_KEY = {
  exact: 'imports.filterExact',
  similar: 'imports.filterSimilar',
  new: 'imports.filterNew',
} as const satisfies Record<StatementRowMatchStatus, string>;

/**
 * The status chips and, under a chosen status, the GROUP decision.
 *
 * `similar` comes first and is visually flagged: those are the lines the user
 * actually has to look at ("I may already have this"), while `exact` is the pile
 * that is safe to leave alone.
 *
 * The group action exists because "keep all my own records" is one gesture, and
 * a client that expressed it as a thousand PATCHes would be a thousand requests
 * — and a half-applied intent if the tab closed halfway. It is offered only
 * under a status chip because the endpoint is keyed by the status, not by a list
 * of ids (§10.8).
 */
export function ImportFilterBar({
  matchStatus,
  counts,
  total,
  readOnly,
  isBulkPending,
  bulkErrorMessage,
  onChange,
  onBulkDecide,
}: ImportFilterBarProps) {
  const t = useT();
  const countOf = (status: StatementRowMatchStatus | null): number =>
    status === null ? total : counts[status];

  return (
    <div className={styles.bar}>
      <div className={styles.chips} role="group" aria-label={t('imports.filterLegend')}>
        {FILTERS.map((status) => {
          const active = matchStatus === status;
          const attention = status === 'similar' && counts.similar > 0;
          return (
            <button
              key={status ?? 'all'}
              type="button"
              className={
                active
                  ? `${styles.chip} ${styles.chipActive}`
                  : attention
                    ? `${styles.chip} ${styles.chipAttention}`
                    : styles.chip
              }
              aria-pressed={active}
              onClick={() => onChange(status)}
            >
              {status === null ? t('imports.filterAll') : t(FILTER_KEY[status])} ·{' '}
              {countOf(status)}
            </button>
          );
        })}
      </div>

      {matchStatus === 'similar' ? (
        <p className={styles.similarHint}>{t('imports.similarHint')}</p>
      ) : null}

      {!readOnly && matchStatus !== null && countOf(matchStatus) > 0 ? (
        <div className={styles.bulk}>
          <span className={styles.bulkLede}>
            {t('imports.bulkLede', { count: countOf(matchStatus) })}
          </span>
          <button
            type="button"
            className={styles.bulkAction}
            disabled={isBulkPending}
            onClick={() => onBulkDecide('import')}
          >
            {t('imports.bulkImport')}
          </button>
          <button
            type="button"
            className={styles.bulkAction}
            disabled={isBulkPending}
            onClick={() => onBulkDecide('skip')}
          >
            {t('imports.bulkSkip')}
          </button>
          {isBulkPending ? (
            <span className={styles.bulkStatus} role="status">
              {t('common.working')}
            </span>
          ) : null}
          {bulkErrorMessage === null ? null : (
            <span className={styles.bulkError} role="alert">
              {bulkErrorMessage}
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}
