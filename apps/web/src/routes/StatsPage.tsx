import { currentMonth, formatApiDate } from '@budget/shared';
import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';

import { buildCategoryIndex } from '../data/categoryLookup';
import { useCategories } from '../data/categories';
import { useStatsSummary } from '../data/stats';
import { CategoryBreakdown } from '../features/stats/CategoryBreakdown';
import { GoalsProgressSection } from '../features/stats/GoalsProgressSection';
import { MonthlyChart } from '../features/stats/MonthlyChart';
import { PeriodPicker } from '../features/stats/PeriodPicker';
import { StatsTotals } from '../features/stats/StatsTotals';
import { TopMerchants } from '../features/stats/TopMerchants';
import { UnconvertedNotice } from '../features/stats/UnconvertedNotice';
import {
  PERIOD_PARAM_KEYS,
  defaultPeriod,
  parsePeriodParams,
  periodLabel,
  periodQuery,
  periodSearchParams,
  type PeriodSelection,
} from '../features/stats/period';
import { describeStatsError } from '../lib/errors';
import styles from './StatsPage.module.css';

/**
 * The stats screen shell. The selected period lives in the URL search params (the
 * TransactionsPage `?month=` precedent), so a period is linkable and survives a
 * reload; `parsePeriodParams` is total, so a hand-edited URL degrades to the
 * current month instead of erroring.
 *
 * Every section owns its own query and its own loading/empty/error state — one
 * failing section never blanks the screen. The monthly chart sits BELOW, outside
 * the period card, because it is not period-scoped (plan Disagreement 1 / R4).
 */
export function StatsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  // Derived during render, never synced through an effect.
  const selection = parsePeriodParams(searchParams);
  const period = periodQuery(selection);

  const summaryQuery = useStatsSummary(period);
  const categoriesQuery = useCategories();
  const categoryIndex = useMemo(
    () => buildCategoryIndex(categoriesQuery.data ?? []),
    [categoriesQuery.data],
  );

  const setSelection = (next: PeriodSelection) => {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      // Clear every period key first: switching unit must not leave a stale
      // anchor in the URL (the request would still be right — periodQuery emits
      // one anchor — but a shared link would carry junk).
      for (const key of PERIOD_PARAM_KEYS) params.delete(key);
      for (const [key, value] of Object.entries(periodSearchParams(next))) {
        params.set(key, value);
      }
      return params;
    });
  };

  // "Back to this month" is only an ACTION when you are not already on it.
  const isCurrentMonth = selection.unit === 'month' && selection.month === currentMonth();

  const summary = summaryQuery.data;
  const failure = summaryQuery.isError ? describeStatsError(summaryQuery.error) : undefined;
  const isEmpty =
    summary !== undefined &&
    summary.income_minor === 0 &&
    summary.expense_minor === 0 &&
    summary.by_category.length === 0;

  return (
    <section className={styles.page}>
      <div className={styles.toolbar}>
        <h1 className={styles.title}>Stats</h1>
        {/* BINDING (task.md): this button ships NOW and is NEVER conditionally
            hidden. There is no capability probe and no endpoint that would let us
            hide it honestly — a server with no AI key answers 503 and the advisor
            panel says exactly that ("AI недоступен — ключ не настроен"). */}
        <Link className={styles.advisorLink} to="/advisor">
          Спросить AI
        </Link>
      </div>

      <div className={styles.periodCard}>
        <PeriodPicker selection={selection} onChange={setSelection} />

        <div
          // A period step keeps the previous numbers on screen, dimmed, instead
          // of flashing back to skeletons (keepPreviousData).
          className={summaryQuery.isPlaceholderData ? styles.dimmed : undefined}
          aria-busy={summaryQuery.isPlaceholderData}
        >
          {summaryQuery.isPending ? (
            <div className={styles.summarySkeleton} aria-hidden="true">
              <div className={styles.skeletonCard} />
              <div className={styles.skeletonCard} />
              <div className={styles.skeletonCard} />
              <div className={styles.skeletonList} />
            </div>
          ) : failure !== undefined ? (
            <p className={styles.error} role="alert">
              {failure.message}
              <button
                type="button"
                className={styles.retry}
                onClick={() => {
                  void summaryQuery.refetch();
                }}
              >
                Retry
              </button>
              {failure.canResetPeriod ? (
                <button
                  type="button"
                  className={styles.retry}
                  onClick={() => setSelection(defaultPeriod())}
                >
                  Reset to this month
                </button>
              ) : null}
            </p>
          ) : summary !== undefined ? (
            <>
              <p className={styles.resolved}>
                {/* For `custom` the client label IS the picked range, so printing
                    it next to the server-echoed bounds said the same dates twice
                    (D2). The echoed bounds are the authoritative ones (WS-1), so
                    the custom arm keeps only those; other units keep the label,
                    which names something the bounds do not ("April 2026"). */}
                {selection.unit === 'custom' ? null : `${periodLabel(selection)} · `}
                {formatApiDate(summary.period.from)} – {formatApiDate(summary.period.to)}
              </p>
              <UnconvertedNotice count={summary.unconverted_count} scope="these totals" />
              <StatsTotals summary={summary} />
              {isEmpty ? (
                <div className={styles.empty}>
                  <p className={styles.emptyTitle}>
                    No transactions in {periodLabel(selection)}.
                  </p>
                  <p className={styles.emptyBody}>
                    {/* The stepper is not rendered for `custom` (period.ts
                        shiftPeriod), so pointing at it there sent the user
                        looking for a control that is not on screen (D3). */}
                    {selection.unit === 'custom'
                      ? 'Add one, or widen the From/To range right above.'
                      : 'Add one, or pick a period you know has activity — the stepper is right above.'}
                  </p>
                  <div className={styles.emptyActions}>
                    <Link className={styles.emptyAction} to="/transactions">
                      Add a transaction
                    </Link>
                    {isCurrentMonth ? null : (
                      <button
                        type="button"
                        className={styles.emptyButton}
                        onClick={() => setSelection(defaultPeriod())}
                      >
                        Back to this month
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <CategoryBreakdown summary={summary} categoryIndex={categoryIndex} />
              )}
            </>
          ) : null}
        </div>
      </div>

      <TopMerchants period={period} />

      <MonthlyChart />

      <GoalsProgressSection />
    </section>
  );
}
