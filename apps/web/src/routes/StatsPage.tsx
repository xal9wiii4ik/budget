import { currentMonth, formatApiDate, sentenceEnd } from '@budget/shared';
import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';

import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { EmptyState } from '../components/EmptyState';
import { PageHeader } from '../components/PageHeader';
import { QueryStateNotice } from '../components/QueryStateNotice';
import { buildCategoryIndex } from '../data/categoryLookup';
import { useCategories } from '../data/categories';
import { useStatsSummary } from '../data/stats';
import { BudgetsSection } from '../features/stats/BudgetsSection';
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
import { useLang, useLocale, useT } from '../i18n/context';
import { networkMessage, describeStatsError } from '../lib/errors';
import { queryPhase } from '../lib/queryPhase';
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
  const lang = useLang();
  const locale = useLocale();
  const t = useT();
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
  const phase = queryPhase(summaryQuery);
  const failure = summaryQuery.isError ? describeStatsError(summaryQuery.error, lang) : undefined;
  const isEmpty =
    summary !== undefined &&
    summary.income_minor === 0 &&
    summary.expense_minor === 0 &&
    summary.by_category.length === 0;

  return (
    <section className={styles.page}>
      <PageHeader
        className={styles.header}
        title={t('stats.title')}
        // BINDING (task.md): this action ships NOW and is NEVER conditionally
        // hidden. There is no capability probe and no endpoint that would let us
        // hide it honestly — a server with no AI key answers 503 and the advisor
        // panel says exactly that.
        actions={
          <Link className={styles.advisorLink} to="/advisor">
            {t('stats.askAi')}
          </Link>
        }
      />

      <Card className={styles.periodCard}>
        <PeriodPicker selection={selection} onChange={setSelection} />

        <div
          // A period step keeps the previous numbers on screen, dimmed, instead
          // of flashing back to skeletons (keepPreviousData).
          className={summaryQuery.isPlaceholderData ? styles.dimmed : undefined}
          aria-busy={summaryQuery.isPlaceholderData}
        >
          {phase === 'loading' ? (
            <div className={styles.summarySkeleton} aria-hidden="true">
              <div className={styles.skeletonCard} />
              <div className={styles.skeletonCard} />
              <div className={styles.skeletonCard} />
              <div className={styles.skeletonList} />
            </div>
          ) : phase === 'error' || phase === 'unreachable' ? (
            <QueryStateNotice
              phase={phase}
              // `failure` is defined exactly when the phase is 'error' (both read
              // `isError`), so the fallback only ever applies to 'unreachable' —
              // where the notice substitutes this same sentence anyway.
              message={failure?.message ?? networkMessage(lang)}
              compact
              onRetry={() => {
                void summaryQuery.refetch();
              }}
            >
              {failure?.canResetPeriod ? (
                <Button size="sm" onClick={() => setSelection(defaultPeriod())}>
                  {t('stats.resetPeriod')}
                </Button>
              ) : null}
            </QueryStateNotice>
          ) : summary !== undefined ? (
            <>
              <p className={styles.resolved}>
                {/* For `custom` the client label IS the picked range, so printing
                    it next to the server-echoed bounds said the same dates twice
                    (D2). The echoed bounds are the authoritative ones (WS-1), so
                    the custom arm keeps only those; other units keep the label,
                    which names something the bounds do not ("April 2026"). */}
                {selection.unit === 'custom' ? null : `${periodLabel(selection, locale)} · `}
                {formatApiDate(summary.period.from, { locale })} – {formatApiDate(summary.period.to, { locale })}
              </p>
              <UnconvertedNotice count={summary.unconverted_count} scope="totals" />
              <StatsTotals summary={summary} />
              {isEmpty ? (
                <EmptyState
                  className={styles.empty}
                  // P3: the ru month label already ends in a dot ("июнь 2026 г."),
                  // so the sentence terminator is added by the shared helper
                  // rather than typed into the JSX.
                  title={sentenceEnd(
                    t('stats.empty', { period: periodLabel(selection, locale) }),
                  )}
                  // The stepper is not rendered for `custom` (period.ts
                  // shiftPeriod), so pointing at it there sent the user looking
                  // for a control that is not on screen (D3).
                  description={t(
                    selection.unit === 'custom'
                      ? 'stats.emptyBodyCustom'
                      : 'stats.emptyBody',
                  )}
                  actions={
                    <>
                      <Link to="/transactions">{t('stats.addTransaction')}</Link>
                      {isCurrentMonth ? null : (
                        <Button size="sm" onClick={() => setSelection(defaultPeriod())}>
                          {t('stats.backToThisMonth')}
                        </Button>
                      )}
                    </>
                  }
                />
              ) : (
                <CategoryBreakdown summary={summary} categoryIndex={categoryIndex} />
              )}
            </>
          ) : null}
        </div>
      </Card>

      {/* Directly under the period card, because it FOLLOWS the picker's month —
          and says so when the picked period is not a month (WR-6). */}
      <BudgetsSection selection={selection} />

      <TopMerchants period={period} />

      <MonthlyChart />

      <GoalsProgressSection />
    </section>
  );
}
