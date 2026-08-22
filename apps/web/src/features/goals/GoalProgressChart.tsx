import { formatMonthShortLabel, formatMoney } from '@budget/shared';
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { useGoalProgress, type GoalRead, type ProgressPoint } from '../../data/goals';
import { useLocale, useT } from '../../i18n/context';
import { moneyTickFormatter } from '../../lib/chartFormat';
import styles from './GoalProgressChart.module.css';

interface GoalProgressChartProps {
  goal: GoalRead;
}

/**
 * The saved-balance series, rendered VERBATIM from GET /goals/{id}/progress.
 *
 * The client does not accumulate (`saved_end_minor` already is a running balance
 * including everything before the window), does not gap-fill (the server emits
 * empty months as 0) and does NOT clamp: a past-dated withdrawal can push an
 * intermediate month below zero, so the Y axis is `['auto','auto']` — the
 * Recharts default of `[0, 'auto']` would flatten a negative dip against the
 * baseline and quietly show a lie (S4/S5 meta-review carry-forward (b)).
 *
 * The only transformation applied anywhere here is minor -> display through the
 * shared money helpers, always with the GOAL's currency (AM-5).
 */
export function GoalProgressChart({ goal }: GoalProgressChartProps) {
  const locale = useLocale();
  const t = useT();
  const progress = useGoalProgress(goal.id);

  if (progress.isPending) {
    // Same box the chart will occupy — no reflow when the data lands.
    return <div className={styles.skeleton} aria-hidden="true" />;
  }

  if (progress.isError) {
    return (
      <p className={styles.error} role="alert">
        {t('goalChart.loadFailed')}
        <button type="button" className={styles.retry} onClick={() => progress.refetch()}>
          {t('common.retry')}
        </button>
      </p>
    );
  }

  const points: ProgressPoint[] = progress.data ?? [];
  const everythingZero = points.every(
    (point) => point.contributed_minor === 0 && point.saved_end_minor === 0,
  );

  // Card-vs-chart reconciliation (carry-forward (a)/(b)): the card's saved total
  // counts EVERY contribution, while the series stops at the current month, so a
  // future-dated contribution makes the two disagree. Said out loud rather than
  // papered over — and by COMPARING the two server numbers, never by computing a
  // difference client-side.
  const lastPoint = points.at(-1);
  const chartTrailsTotal =
    lastPoint !== undefined && lastPoint.saved_end_minor !== goal.saved_minor;

  if (points.length === 0 || everythingZero) {
    return (
      <p className={styles.empty}>
        {chartTrailsTotal
          ? t('goalChart.emptyFutureOnly', {
              amount: formatMoney(goal.saved_minor, goal.currency, { locale }),
            })
          : t('goalChart.empty')}
      </p>
    );
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.chartBox}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={points}
            margin={{ top: 8, right: 8, bottom: 0, left: 8 }}
            // Recharts' keyboard/screen-reader layer: arrow keys walk the series.
            accessibilityLayer
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#eef0f2" />
            <XAxis
              dataKey="month"
              tickFormatter={(month: string) => formatMonthShortLabel(month, { locale })}
              tick={{ fontSize: 11 }}
              minTickGap={12}
            />
            <YAxis
              // Never [0, 'auto']: negative balances must be visible, not clipped.
              domain={['auto', 'auto']}
              width={72}
              tick={{ fontSize: 11 }}
              tickFormatter={moneyTickFormatter(goal.currency, locale)}
            />
            <Tooltip
              labelFormatter={(label) =>
                typeof label === 'string' ? formatMonthShortLabel(label, { locale }) : label
              }
              // Recharts types the payload value loosely (string | number | array);
              // only a real integer minor value goes through the money formatter.
              formatter={(value, name) => [
                typeof value === 'number' && Number.isSafeInteger(value)
                  ? formatMoney(value, goal.currency, { locale })
                  : String(value),
                name,
              ]}
            />
            <ReferenceLine
              y={goal.target_minor}
              stroke="#16a34a"
              strokeDasharray="4 4"
              // Keep the target visible even when the balance is far below it.
              ifOverflow="extendDomain"
              label={{
                value: t('goalChart.target'),
                position: 'insideTopRight',
                fontSize: 11,
              }}
            />
            {/* The month's own net movement: negative bars ARE withdrawals, drawn
                below the zero line rather than hidden. */}
            <Bar
              dataKey="contributed_minor"
              name={t('goalChart.thisMonth')}
              fill="#93c5fd"
              barSize={10}
            />
            <Area
              type="monotone"
              dataKey="saved_end_minor"
              name={t('goalChart.saved')}
              stroke="#2563eb"
              fill="#dbeafe"
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {chartTrailsTotal ? (
        <p className={styles.note} role="status">
          {t('goalChart.trailingNote', {
            amount: formatMoney(goal.saved_minor, goal.currency, { locale }),
          })}
        </p>
      ) : null}
    </div>
  );
}
