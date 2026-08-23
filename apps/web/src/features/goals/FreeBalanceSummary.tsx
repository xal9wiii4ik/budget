import { formatMonthShortLabel, formatMoney, sentenceEnd } from '@budget/shared';
import type { ReactElement } from 'react';
import { Link } from 'react-router';

import type { GoalListRead } from '../../data/goals';
import { useLocale, useT } from '../../i18n/context';
import { freeBalanceWindow } from './freeBalanceWindow';
import styles from './FreeBalanceSummary.module.css';

/** The server's window: the 3 full months before the current one (services/goal_reads.py). */
const WINDOW_MONTHS = 3;

/** Where the "no basis" / "zero declared" arms send the user. */
const INCOME_SETTINGS_PATH = '/settings?focus=income';

interface FreeBalanceSummaryProps {
  list: GoalListRead;
}

/**
 * What the free balance below the goals header actually MEANS — an exhaustive
 * switch over `free_balance_basis` (D2).
 *
 * The return type is annotated on purpose: with no `default` arm, a fourth basis
 * value on the wire makes this function fall through to an implicit `undefined`
 * return, which `ReactElement` rejects at typecheck. A blank box on /goals is
 * exactly the failure this scope exists to stop, so it must be a build error.
 *
 * The month WINDOW caption (recurring-dates-and-income W2) is shown in the
 * `average` arm only, and its wording is untouched: it is a true statement about
 * which months were scanned. In the other two arms no month contributed anything
 * to the figure, so naming three of them would be the same overclaim in a new
 * place.
 */
export function FreeBalanceSummary({ list }: FreeBalanceSummaryProps): ReactElement {
  const locale = useLocale();
  const t = useT();

  const amount = formatMoney(list.free_balance_minor, list.base_currency, { locale });

  switch (list.free_balance_basis) {
    case 'average': {
      // Which three months the server looked at. Derived, not fetched: the API
      // exposes no window boundaries and needs none — this is calendar labelling,
      // not money arithmetic (architecture C). Computed at render from the
      // current instant; a tab left open across a month boundary relabels on its
      // next render, exactly like every other date on screen.
      const window = freeBalanceWindow(new Date());
      const months = list.free_balance_months_with_data;
      // The average divides by the months that HAD activity, so "the last 3 full
      // months" is only honest when all three did (OQ-2 ruling). With 1 or 2 the
      // sentence says how many — one stray row in one month is a real, accepted
      // case (task.md "Known edge") and it must not read as a 3-month average.
      const wholeWindow = months >= WINDOW_MONTHS;

      return (
        <>
          {list.free_balance_minor > 0 ? (
            <p className={styles.line}>
              {wholeWindow
                ? t('goals.freeBalancePrefix')
                : t('goals.freeBalancePrefixPartial', { count: months })}{' '}
              <strong>{amount}</strong> {t('goals.freeBalanceSuffix')}
            </p>
          ) : (
            <p className={styles.line}>
              {wholeWindow
                ? t('goals.freeBalanceNone', { amount })
                : t('goals.freeBalanceNonePartial', { count: months, amount })}
            </p>
          )}
          <p className={styles.line}>
            {/* The sentence ENDS on a month label, and ru month labels already end
                in "г." — `sentenceEnd` is what keeps that from rendering as "г..". */}
            {sentenceEnd(
              t('goals.freeBalanceBasis', {
                from: formatMonthShortLabel(window.fromMonth, { locale }),
                to: formatMonthShortLabel(window.toMonth, { locale }),
              }),
            )}{' '}
            {t('goals.freeBalanceCurrentMonthNote')}
          </p>
        </>
      );
    }

    case 'declared': {
      // A declared income of 0 passes the server's `>= 0` CHECK, so this arm is
      // reachable and needs its own sentence: "you had about 0 left over" would
      // read as a measurement of a month that was never measured.
      if (list.free_balance_minor <= 0) {
        return (
          <>
            <p className={styles.line}>{t('goals.freeBalanceDeclaredZero')}</p>
            <p className={styles.line}>
              <Link className={styles.link} to={INCOME_SETTINGS_PATH}>
                {t('goals.freeBalanceNoBasisLink')}
              </Link>
            </p>
          </>
        );
      }
      return (
        <>
          <p className={styles.line}>
            {t('goals.freeBalanceDeclaredPrefix')} <strong>{amount}</strong>{' '}
            {t('goals.freeBalanceDeclaredSuffix')}
          </p>
          <p className={styles.line}>{t('goals.freeBalanceDeclaredBasis')}</p>
        </>
      );
    }

    case 'none':
      return (
        <div className={styles.noBasis}>
          <p className={styles.noBasisTitle}>{t('goals.freeBalanceNoBasisTitle')}</p>
          <p className={styles.line}>{t('goals.freeBalanceNoBasisBody')}</p>
          <Link className={styles.link} to={INCOME_SETTINGS_PATH}>
            {t('goals.freeBalanceNoBasisLink')}
          </Link>
        </div>
      );
  }
}
