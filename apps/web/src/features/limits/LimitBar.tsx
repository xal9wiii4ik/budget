import { formatMoney } from '@budget/shared';

import { useLocale, useT } from '../../i18n/context';

import type { LimitProgress } from './limitProgress';
import styles from './LimitBar.module.css';

interface LimitBarProps {
  /** Already decided by `limitProgress` — this component never compares anything. */
  progress: LimitProgress;
  /** What is being measured (the category name), for the accessible name. */
  label: string;
}

/**
 * One budget, rendered. Shared by `/categories` (W4) and the read-only `/stats`
 * section (W5), so both surfaces say the same thing about the same numbers.
 *
 * It renders only the FACTS — no Set/Edit/Remove: the write affordances belong to
 * the one write surface (`/categories`) and are the caller's to add.
 *
 * The mismatch arm (D15/WR-5) is the reason this is a union and not a bar with an
 * "error" flag: when `limit_currency !== currency` there is nothing to measure,
 * so there is no bar, no ratio and deliberately NO `role="progressbar"` — an
 * empty progressbar would tell a screen-reader user "0 of 30 000" about two
 * amounts that are not comparable in the first place. Each amount is formatted
 * with ITS OWN currency (AM-5); neither is ever a fallback for the other.
 */
export function LimitBar({ progress, label }: LimitBarProps) {
  const locale = useLocale();
  const t = useT();
  const limitText = formatMoney(progress.limitMinor, progress.limitCurrency, { locale });
  const spentText = formatMoney(progress.spentMinor, progress.currency, { locale });

  if (progress.status === 'mismatch') {
    return (
      <div className={styles.wrap}>
        <p className={styles.amounts}>
          {t('limitBar.budgetLabel')} <strong>{limitText}</strong> ·{' '}
          {t('limitBar.spentInline', { amount: spentText })}
        </p>
        <p className={styles.mismatch}>
          {t('limitBar.mismatch', {
            limitCurrency: progress.limitCurrency,
            currency: progress.currency,
          })}
        </p>
      </div>
    );
  }

  const over = progress.status === 'over';
  const pair = t('limitBar.pair', { spent: spentText, limit: limitText });

  return (
    <div className={styles.wrap}>
      <p className={styles.amounts}>
        <strong>{spentText}</strong> {t('limitBar.ofLimit', { limit: limitText })}
      </p>
      <div
        className={styles.bar}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={progress.limitMinor}
        // Clamped to the track: ARIA requires valuenow within [min, max], and an
        // overrun is announced by `aria-valuetext` — which takes precedence — as
        // the real pair rather than as an out-of-range number.
        aria-valuenow={Math.min(progress.spentMinor, progress.limitMinor)}
        // Minor units are meaningless read aloud (the shipped GoalCard rule).
        aria-valuetext={pair}
        aria-label={t('limitBar.aria', { name: label })}
      >
        <div
          className={over ? `${styles.barFill} ${styles.barFillOver}` : styles.barFill}
          style={{ width: `${progress.ratio * 100}%` }}
        />
      </div>
      {over ? (
        // Informational, not an alert: going over a self-set budget is a fact
        // about the month, not an error the user must resolve.
        <p className={styles.over} role="status">
          {t('limitBar.over', {
            amount: formatMoney(Math.abs(progress.remainingMinor), progress.currency, {
              locale,
            }),
          })}
        </p>
      ) : (
        <p className={styles.remaining}>
          {t('limitBar.left', {
            amount: formatMoney(progress.remainingMinor, progress.currency, { locale }),
          })}
        </p>
      )}
    </div>
  );
}
