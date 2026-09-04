import { formatMonthShortLabel, formatMoney } from '@budget/shared';
import { useState } from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { QueryStateNotice } from '../../components/QueryStateNotice';
import {
  DEFAULT_MONTHLY_WINDOW,
  MONTHLY_WINDOWS,
  useStatsMonthly,
  type MonthlyPoint,
  type MonthlyWindow,
} from '../../data/stats';
import { useLocale, useT } from '../../i18n/context';
import { moneyTickFormatter } from '../../lib/chartFormat';
import { queryPhase } from '../../lib/queryPhase';
import { useChartColors } from './chartColors';
import styles from './MonthlyChart.module.css';

/**
 * The trailing monthly dynamics, rendered VERBATIM from GET /stats/monthly.
 *
 * This section is deliberately OUTSIDE the period card and carries its own
 * window selector: `/stats/monthly` is not period-scoped (server D4 — `months=N`
 * ending at the current month), so showing it inside a card that says "2024"
 * would be a misreading waiting to happen (plan Disagreement 1, senior-lead R4).
 *
 * The client does not accumulate, gap-fill, clamp or re-order the series (the
 * server emits empty months as zeros, in order), and the Y axis is
 * `['auto','auto']` — never `[0,'auto']`, which would flatten a negative net
 * month against the baseline and quietly show a lie. Every amount decodes with
 * `monthly.currency`, this response's own field (AM-5).
 *
 * Two honesty surfaces, both required by WS-5:
 *  - the LAST point is the current, still-running month, so it always looks like
 *    a dip; it is labelled "this month so far" rather than explained away;
 *  - `unconverted_count` is PER POINT (that is why D4 made it per-point), so it
 *    shows in that month's tooltip and the flagged months are named under the
 *    chart — never collapsed into one number for the whole window.
 */
export function MonthlyChart() {
  const t = useT();
  // A genuine view preference (transient, client-only) — useState, not the Query
  // cache and not a store.
  const [months, setMonths] = useState<MonthlyWindow>(DEFAULT_MONTHLY_WINDOW);
  const monthly = useStatsMonthly(months);

  return (
    <section className={styles.section} aria-labelledby="monthly-heading">
      <header className={styles.header}>
        <h2 id="monthly-heading" className={styles.heading}>
          {t('monthly.heading', { months })}
        </h2>
        <div className={styles.windows} role="group" aria-label={t('monthly.windowGroup')}>
          {MONTHLY_WINDOWS.map((option) => (
            <button
              key={option}
              type="button"
              className={
                option === months ? `${styles.window} ${styles.windowActive}` : styles.window
              }
              aria-pressed={option === months}
              onClick={() => setMonths(option)}
            >
              {option}
            </button>
          ))}
        </div>
      </header>
      <p className={styles.scopeNote}>{t('monthly.scopeNote')}</p>

      <MonthlyBody
        months={months}
        query={monthly}
        onRetry={() => {
          void monthly.refetch();
        }}
      />
    </section>
  );
}

interface MonthlyBodyProps {
  months: number;
  query: ReturnType<typeof useStatsMonthly>;
  onRetry: () => void;
}

function MonthlyBody({ months, query, onRetry }: MonthlyBodyProps) {
  const locale = useLocale();
  const t = useT();
  // Series colours come from the tokens, resolved once per theme: the same green
  // and red the money rows use, so the chart reads as this app in both themes.
  const colors = useChartColors();
  const phase = queryPhase(query);

  if (phase === 'error' || phase === 'unreachable') {
    return (
      <QueryStateNotice
        phase={phase}
        message={t('monthly.loadFailed')}
        compact
        onRetry={onRetry}
      />
    );
  }

  if (!query.isSuccess) {
    // 'loading' — the failing phases returned above. Same box the chart will
    // occupy, so there is no reflow when the data lands.
    return <div className={styles.skeleton} aria-hidden="true" />;
  }

  const monthly = query.data;
  const points = monthly.points;
  const { currency } = monthly;
  // The window ends at the current month by contract, so the LAST point IS the
  // partial one — read off the server's own series rather than from a client
  // clock reading of "today".
  const currentMonthKey = points.at(-1)?.month;
  const flagged = points.filter((point) => point.unconverted_count > 0);
  const everythingZero = points.every(
    (point) => point.income_minor === 0 && point.expense_minor === 0,
  );

  return (
    <div
      className={query.isPlaceholderData ? `${styles.body} ${styles.dimmed}` : styles.body}
      aria-busy={query.isPlaceholderData}
    >
      <div className={styles.chartBox}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={points}
            margin={{ top: 8, right: 8, bottom: 0, left: 8 }}
            // Recharts' keyboard/screen-reader layer: arrow keys walk the series.
            accessibilityLayer
          >
            <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} />
            <XAxis
              dataKey="month"
              tickFormatter={(month: string) => formatMonthShortLabel(month, { locale })}
              stroke={colors.grid}
              tick={{ fontSize: 11, fill: colors.axis }}
              minTickGap={8}
            />
            <YAxis
              // Never [0, 'auto']: a negative net month must be visible.
              domain={['auto', 'auto']}
              width={72}
              stroke={colors.grid}
              tick={{ fontSize: 11, fill: colors.axis }}
              tickFormatter={moneyTickFormatter(currency, locale)}
            />
            <Tooltip
              // Recharts' default hover band is a fixed light grey — a pale patch
              // over a dark card. The muted surface token is the app's own hover.
              cursor={{ fill: colors.cursor }}
              content={(props) => {
                if (!props.active) return null;
                const month = typeof props.label === 'string' ? props.label : undefined;
                // Look the point up by its own month key instead of reading
                // Recharts' loosely-typed payload — same data, fully typed.
                const point = month
                  ? points.find((candidate) => candidate.month === month)
                  : undefined;
                if (!point) return null;
                return (
                  <MonthlyTooltip
                    point={point}
                    currency={currency}
                    isCurrentMonth={point.month === currentMonthKey}
                  />
                );
              }}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar
              dataKey="income_minor"
              name={t('common.income')}
              fill={colors.income}
              barSize={10}
              isAnimationActive={false}
            />
            <Bar
              dataKey="expense_minor"
              name={t('statsTotals.expenses')}
              fill={colors.expense}
              barSize={10}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="net_minor"
              name={t('common.net')}
              stroke={colors.net}
              dot={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {everythingZero ? (
        // A flatline IS information; a spinner is not. The axes stay.
        <p className={styles.empty}>{t('monthly.emptyWindow')}</p>
      ) : null}

      {currentMonthKey ? (
        <p className={styles.note}>
          {t('monthly.currentMonthNote', {
            month: formatMonthShortLabel(currentMonthKey, { locale }),
          })}
        </p>
      ) : null}

      {flagged.length > 0 ? (
        <p className={styles.note} role="status">
          {t('monthly.flaggedNote', {
            months: flagged
              .map((point) => formatMonthShortLabel(point.month, { locale }))
              .join(', '),
          })}
        </p>
      ) : null}

      <p className={styles.note}>{t('monthly.footer', { currency, months })}</p>
    </div>
  );
}

interface MonthlyTooltipProps {
  point: MonthlyPoint;
  currency: string;
  isCurrentMonth: boolean;
}

function MonthlyTooltip({ point, currency, isCurrentMonth }: MonthlyTooltipProps) {
  const locale = useLocale();
  const t = useT();
  return (
    <div className={styles.tooltip}>
      <p className={styles.tooltipTitle}>
        {formatMonthShortLabel(point.month, { locale })}
        {isCurrentMonth ? t('monthly.thisMonthSoFar') : ''}
      </p>
      <p className={styles.tooltipRow}>
        {t('common.income')} {formatMoney(point.income_minor, currency, { locale })}
      </p>
      <p className={styles.tooltipRow}>
        {t('statsTotals.expenses')} {formatMoney(point.expense_minor, currency, { locale })}
      </p>
      <p className={styles.tooltipRow}>
        {t('common.net')} {formatMoney(point.net_minor, currency, { locale })}
      </p>
      {point.unconverted_count > 0 ? (
        <p className={styles.tooltipFlag}>
          {t('unconverted.month', { count: point.unconverted_count })}
        </p>
      ) : null}
    </div>
  );
}
