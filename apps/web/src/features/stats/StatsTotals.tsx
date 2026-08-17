import { formatApiDate, formatMoney } from '@budget/shared';

import type { StatsSummaryRead } from '../../data/stats';
import { compare, toneForDelta, type Comparison } from './comparison';
import styles from './StatsTotals.module.css';

interface StatsTotalsProps {
  summary: StatsSummaryRead;
}

type Metric = 'income' | 'expense' | 'net';

const METRICS: readonly { key: Metric; label: string }[] = [
  { key: 'income', label: 'Income' },
  { key: 'expense', label: 'Expenses' },
  { key: 'net', label: 'Net' },
];

function currentMinor(summary: StatsSummaryRead, metric: Metric): number {
  if (metric === 'income') return summary.income_minor;
  if (metric === 'expense') return summary.expense_minor;
  return summary.net_minor;
}

function previousMinor(summary: StatsSummaryRead, metric: Metric): number {
  if (metric === 'income') return summary.previous.income_minor;
  if (metric === 'expense') return summary.previous.expense_minor;
  return summary.previous.net_minor;
}

/**
 * Income / expenses / net for the resolved period, each with its comparison to
 * the SAME-LENGTH previous window the server resolved and shipped.
 *
 * Every amount is decoded with `summary.currency` — this response's own field
 * (AM-5), never another response's and never a hardcoded code. Both operands of
 * every delta come from this one response, so the subtraction can never mix
 * denominations. The only arithmetic is `compare()` (features/stats/comparison).
 */
export function StatsTotals({ summary }: StatsTotalsProps) {
  const { currency } = summary;
  // WS-5: a previous window that itself dropped transactions is not a sound base
  // for a crisp percentage. The delta still renders; the percent does not.
  const previousIncomplete = summary.previous.unconverted_count > 0;

  return (
    <div className={styles.totals}>
      {METRICS.map(({ key, label }) => {
        const comparison = compare(currentMinor(summary, key), previousMinor(summary, key));
        return (
          <div key={key} className={styles.card}>
            <span className={styles.label}>{label}</span>
            <span className={`${styles.value} ${styles[key]}`}>
              {formatMoney(currentMinor(summary, key), currency)}
            </span>
            <ComparisonLine
              comparison={comparison}
              metric={key}
              currency={currency}
              previousMinor={previousMinor(summary, key)}
              previousIncomplete={previousIncomplete}
            />
          </div>
        );
      })}
      <p className={styles.window}>
        Compared with {formatApiDate(summary.previous.from)} –{' '}
        {formatApiDate(summary.previous.to)} — the same length immediately before,
        resolved by the server.
      </p>
    </div>
  );
}

interface ComparisonLineProps {
  comparison: Comparison;
  metric: Metric;
  currency: string;
  previousMinor: number;
  previousIncomplete: boolean;
}

function ComparisonLine({
  comparison,
  metric,
  currency,
  previousMinor,
  previousIncomplete,
}: ComparisonLineProps) {
  if (comparison.kind === 'both-zero') {
    // "Same as last period" would be a quiet lie when last period itself dropped
    // rows for want of a rate: its zero is not a known zero.
    return (
      <span className={styles.comparisonNeutral}>
        {previousIncomplete
          ? 'Nothing this period — and last period is incomplete.'
          : 'Same as last period — both zero.'}
      </span>
    );
  }

  const { deltaMinor } = comparison;
  // Intl renders the locale-correct minus; the plus is ours, so a rise is never
  // ambiguous at a glance.
  const signedDelta =
    deltaMinor > 0
      ? `+${formatMoney(deltaMinor, currency)}`
      : formatMoney(deltaMinor, currency);
  const tone = toneForDelta(deltaMinor, metric);
  const className = `${styles.comparison} ${
    tone === 'warning' ? styles.warning : tone === 'positive' ? styles.positive : styles.neutralTone
  }`;

  if (previousIncomplete) {
    return (
      <span className={className}>
        {signedDelta}{' '}
        <span className={styles.qualifier}>
          — last period is incomplete, so no percentage
        </span>
      </span>
    );
  }

  if (comparison.kind === 'no-base') {
    return (
      <span className={className}>
        {signedDelta}{' '}
        <span className={styles.qualifier}>
          {previousMinor === 0
            ? '— nothing last period'
            : '— last period was negative, so no percentage'}
        </span>
      </span>
    );
  }

  return (
    <span className={className}>
      {signedDelta}{' '}
      <span className={styles.percent}>
        ({comparison.percent > 0 ? '+' : ''}
        {comparison.percent}%)
      </span>
    </span>
  );
}
