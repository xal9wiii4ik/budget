import type { components } from '@budget/api-client';

import type { StatementRowDecision, StatementRowMatchStatus } from '../../data/imports';
import { Button } from '../../components/Button';
import { useT } from '../../i18n/context';
import styles from './ImportFilterBar.module.css';

type MatchStatusCounts = components['schemas']['MatchStatusCounts'];

interface ImportFilterBarProps {
  matchStatus: StatementRowMatchStatus | null;
  /** The session's `by_match_status` — server counters, never counted here. */
  counts: MatchStatusCounts;
  /** `rows_total`: the "all" chip is not the sum of the other three, it is a field. */
  total: number;
  /** ai-layer W1: the AI chip, independent of the status chips above. */
  needsReview: boolean;
  /**
   * `ai_rows_flagged` — the session's UNFILTERED count of rows the model was
   * not sure about. Deliberately NOT intersected with `by_match_status`: the
   * honest answer to "how many still need a look" is the whole statement's,
   * while the list below shows the intersection of both chips.
   */
  flaggedCount: number;
  readOnly: boolean;
  isBulkPending: boolean;
  bulkErrorMessage: string | null;
  onChange: (status: StatementRowMatchStatus | null) => void;
  onToggleNeedsReview: (next: boolean) => void;
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
 * of ids (§10.8) — and it is HIDDEN while the AI chip narrows the list, because
 * the endpoint would move every row of that status, including the ones the
 * filter is currently hiding. "All 40 lines with this status" would be a lie
 * about the 6 on screen (ai-layer W1).
 */
export function ImportFilterBar({
  matchStatus,
  counts,
  total,
  needsReview,
  flaggedCount,
  readOnly,
  isBulkPending,
  bulkErrorMessage,
  onChange,
  onToggleNeedsReview,
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
            <Button
              key={status ?? 'all'}
              size="sm"
              variant={active ? 'primary' : 'secondary'}
              className={
                !active && attention ? `${styles.chip} ${styles.chipAttention}` : styles.chip
              }
              aria-pressed={active}
              onClick={() => onChange(status)}
            >
              {status === null ? t('imports.filterAll') : t(FILTER_KEY[status])} ·{' '}
              {countOf(status)}
            </Button>
          );
        })}
      </div>

      {/* A second, INDEPENDENT group: the server ANDs the two filters, so "new
          AND needs a look" is a legitimate view and this is not a fourth status
          chip. Hidden when there is nothing flagged AND the chip is off — a
          statement no model touched gets no control about AI; once it is ON it
          stays rendered even at zero, or there would be no way to turn it off. */}
      {flaggedCount > 0 || needsReview ? (
        // No `role="group"` here, unlike the status chips: a group of ONE whose
        // label repeats its only button's text just makes a screen reader say
        // the same words twice.
        <div className={styles.chips}>
          <Button
            size="sm"
            variant={needsReview ? 'primary' : 'secondary'}
            className={
              needsReview || flaggedCount === 0
                ? styles.chip
                : `${styles.chip} ${styles.chipFlagged}`
            }
            aria-pressed={needsReview}
            onClick={() => onToggleNeedsReview(!needsReview)}
          >
            {t('imports.filterNeedsReview')} · {flaggedCount}
          </Button>
        </div>
      ) : null}

      {matchStatus === 'similar' ? (
        <p className={styles.similarHint}>{t('imports.similarHint')}</p>
      ) : null}

      {needsReview ? (
        <p className={styles.needsReviewHint}>{t('imports.needsReviewHint')}</p>
      ) : null}

      {!readOnly && !needsReview && matchStatus !== null && countOf(matchStatus) > 0 ? (
        <div className={styles.bulk}>
          <span className={styles.bulkLede}>
            {t('imports.bulkLede', { count: countOf(matchStatus) })}
          </span>
          <Button size="sm" disabled={isBulkPending} onClick={() => onBulkDecide('import')}>
            {t('imports.bulkImport')}
          </Button>
          <Button size="sm" disabled={isBulkPending} onClick={() => onBulkDecide('skip')}>
            {t('imports.bulkSkip')}
          </Button>
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
