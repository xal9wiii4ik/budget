import { formatMoney } from '@budget/shared';

import { Card } from '../../components/Card';
import type { DebtSummaryRead } from '../../data/debts';
import { useLocale, useT } from '../../i18n/context';
import styles from './DebtSummary.module.css';

interface DebtSummaryHeaderProps {
  /** `undefined` while the list read is still in flight. */
  summary: DebtSummaryRead | undefined;
}

/**
 * "Мне должны / Я должен" in the profile base currency.
 *
 * Both figures are SERVER fields on the list response: Σ remaining of the OPEN
 * debts of one side, converted debt→base at today's nearest-previous rate. This
 * component therefore sums nothing, converts nothing and compares nothing — it
 * does not even subtract one side from the other, because a "net position"
 * across currencies is not a number anybody here is entitled to invent.
 *
 * The two unconverted counters are the honesty half of the same contract (the
 * `SummaryHeader` / `UnconvertedNotice` pattern): a debt whose currency has no
 * rate today is COUNTED beside its side rather than silently added as zero, and
 * each side carries its own counter because they are separate sums.
 */
export function DebtSummaryHeader({ summary }: DebtSummaryHeaderProps) {
  const locale = useLocale();
  const t = useT();

  if (summary === undefined) {
    // A placeholder of the figures' height, so the list below does not jump when
    // the response lands. Never a zero: a figure we do not have must not be drawn.
    return (
      <Card aria-hidden="true">
        <div className={styles.figures}>
          {(['debts.groupLent', 'debts.groupBorrowed'] as const).map((key) => (
            <div key={key} className={styles.figure}>
              <span className={styles.label}>{t(key)}</span>
              <span className={styles.skeletonFigure} />
            </div>
          ))}
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className={styles.figures}>
        <div className={styles.figure}>
          <span className={styles.label}>{t('debts.groupLent')}</span>
          <span className={`${styles.value} ${styles.lent} tnum`}>
            {formatMoney(summary.owed_to_me_minor, summary.base_currency, { locale })}
          </span>
        </div>
        <div className={styles.figure}>
          <span className={styles.label}>{t('debts.groupBorrowed')}</span>
          <span className={`${styles.value} ${styles.borrowed} tnum`}>
            {formatMoney(summary.i_owe_minor, summary.base_currency, { locale })}
          </span>
        </div>
      </div>

      {/* The conversion is the server's and it is dated TODAY — saying so is what
          stops the two figures from reading as the sum of the rows below. */}
      <p className={styles.hint}>
        {t('debts.summaryHint', { currency: summary.base_currency })}
      </p>

      {/* One note per SIDE: the counters are about two different sums, and a
          merged sentence could not say which figure is incomplete. */}
      {summary.owed_to_me_unconverted_count > 0 ? (
        <p className={styles.unconverted} role="status">
          {t('debts.groupLent')}:{' '}
          {t('debts.summaryUnconverted', { count: summary.owed_to_me_unconverted_count })}
        </p>
      ) : null}
      {summary.i_owe_unconverted_count > 0 ? (
        <p className={styles.unconverted} role="status">
          {t('debts.groupBorrowed')}:{' '}
          {t('debts.summaryUnconverted', { count: summary.i_owe_unconverted_count })}
        </p>
      ) : null}
    </Card>
  );
}
