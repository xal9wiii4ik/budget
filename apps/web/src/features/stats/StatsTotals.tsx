import { formatApiDate, formatMoney } from '@budget/shared';

import type { StatsSummaryRead } from '../../data/stats';
import { compare, toneForDelta, type Comparison } from './comparison';
import { useLocale, useT } from '../../i18n/context';
import type { SimpleKey } from '../../i18n/t';
import styles from './StatsTotals.module.css';

interface StatsTotalsProps {
  summary: StatsSummaryRead;
}

type Metric = 'income' | 'expense' | 'net';

const METRICS: readonly { key: Metric; labelKey: SimpleKey }[] = [
  { key: 'income', labelKey: 'common.income' },
  { key: 'expense', labelKey: 'statsTotals.expenses' },
  { key: 'net', labelKey: 'common.net' },
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
  const locale = useLocale();
  const t = useT();
  const { currency } = summary;
  // WS-5: a previous window that itself dropped transactions is not a sound base
  // for a crisp percentage. The delta still renders; the percent does not.
  const previousIncomplete = summary.previous.unconverted_count > 0;

  return (
    <div className={styles.totals}>
      {METRICS.map(({ key, labelKey }) => {
        const comparison = compare(currentMinor(summary, key), previousMinor(summary, key));
        return (
          <div key={key} className={styles.card}>
            <span className={styles.label}>{t(labelKey)}</span>
            <span className={`${styles.value} ${styles[key]} tnum`}>
              {formatMoney(currentMinor(summary, key), currency, { locale })}
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
        {t('statsTotals.comparedWith', {
          from: formatApiDate(summary.previous.from, { locale }),
          to: formatApiDate(summary.previous.to, { locale }),
        })}
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
  const locale = useLocale();
  const t = useT();
  if (comparison.kind === 'both-zero') {
    // "Same as last period" would be a quiet lie when last period itself dropped
    // rows for want of a rate: its zero is not a known zero.
    return (
      <span className={styles.comparisonNeutral}>
        {t(
          previousIncomplete
            ? 'statsTotals.bothZeroIncomplete'
            : 'statsTotals.bothZero',
        )}
      </span>
    );
  }

  const { deltaMinor } = comparison;
  // Intl renders the locale-correct minus; the plus is ours, so a rise is never
  // ambiguous at a glance.
  const signedDelta =
    deltaMinor > 0
      ? `+${formatMoney(deltaMinor, currency, { locale })}`
      : formatMoney(deltaMinor, currency, { locale });
  const tone = toneForDelta(deltaMinor, metric);
  const className = `${styles.comparison} ${
    tone === 'warning' ? styles.warning : tone === 'positive' ? styles.positive : styles.neutralTone
  }`;

  if (previousIncomplete) {
    return (
      <span className={className}>
        {signedDelta}{' '}
        <span className={styles.qualifier}>{t('statsTotals.incomplete')}</span>
      </span>
    );
  }

  if (comparison.kind === 'no-base') {
    return (
      <span className={className}>
        {signedDelta}{' '}
        <span className={styles.qualifier}>
          {t(
            previousMinor === 0
              ? 'statsTotals.noBaseZero'
              : 'statsTotals.noBaseNegative',
          )}
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
