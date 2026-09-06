// What the free balance above the goals list actually MEANS — an EXHAUSTIVE
// switch over `free_balance_basis` (base-currency-and-goal-basis D2), ported from
// web's features/goals/FreeBalanceSummary.tsx with the same three arms and the
// same refusal to overclaim.
//
// The return type is annotated on purpose: with no `default` arm, a fourth basis
// value on the wire makes this function fall through to an implicit `undefined`
// return, which `ReactElement` rejects at typecheck. A blank box here is exactly
// the failure that scope exists to stop, so it must be a build error.
//
// The month WINDOW caption is shown in the `average` arm only: in the other two
// no month contributed anything to the figure, so naming three of them would be
// the same overclaim in a new place.
import { formatMonthShortLabel, formatMoney, sentenceEnd } from '@budget/shared';
import { router } from 'expo-router';
import type { ReactElement } from 'react';
import { Pressable, Text } from 'react-native';

import { Card } from '../../components/Card';
import { themedStyles } from '../../theme/themedStyles';
import type { GoalListRead } from '../../data/goals';
import { useLocale, useT } from '../../i18n/context';
import { freeBalanceWindow } from './freeBalanceWindow';

/** The server's window: the 3 full months before the current one. */
const WINDOW_MONTHS = 3;

interface FreeBalanceSummaryProps {
  list: GoalListRead;
}

export function FreeBalanceSummary({ list }: FreeBalanceSummaryProps): ReactElement {
  const locale = useLocale();
  const t = useT();
  const styles = useStyles();

  const amount = formatMoney(list.free_balance_minor, list.base_currency, { locale });

  switch (list.free_balance_basis) {
    case 'average': {
      // Which three months the server looked at. Derived, not fetched: the API
      // exposes no window boundaries and needs none — this is calendar labelling,
      // not money arithmetic. Computed at render, like every other date here.
      const window = freeBalanceWindow(new Date());
      const months = list.free_balance_months_with_data;
      // The average divides by the months that HAD activity, so "the last 3 full
      // months" is only honest when all three did. With 1 or 2 the sentence says
      // how many.
      const wholeWindow = months >= WINDOW_MONTHS;

      return (
        <Card padding="none" style={styles.box}>
          {list.free_balance_minor > 0 ? (
            <Text style={styles.line}>
              {wholeWindow
                ? t('goals.freeBalancePrefix')
                : t('goals.freeBalancePrefixPartial', { count: months })}{' '}
              <Text style={styles.amount}>{amount}</Text> {t('goals.freeBalanceSuffix')}
            </Text>
          ) : (
            <Text style={styles.line}>
              {wholeWindow
                ? t('goals.freeBalanceNone', { amount })
                : t('goals.freeBalanceNonePartial', { count: months, amount })}
            </Text>
          )}
          <Text style={styles.muted}>
            {/* The sentence ENDS on a month label, and ru month labels already end
                in "г." — `sentenceEnd` is what keeps that from rendering as "г..". */}
            {sentenceEnd(
              t('goals.freeBalanceBasis', {
                from: formatMonthShortLabel(window.fromMonth, { locale }),
                to: formatMonthShortLabel(window.toMonth, { locale }),
              }),
            )}{' '}
            {t('goals.freeBalanceCurrentMonthNote')}
          </Text>
        </Card>
      );
    }

    case 'declared': {
      // A declared income of 0 passes the server's `>= 0` CHECK, so this arm is
      // reachable and needs its own sentence: "you had about 0 left over" would
      // read as a measurement of a month that was never measured.
      if (list.free_balance_minor <= 0) {
        return (
          <Card padding="none" style={styles.box}>
            <Text style={styles.line}>{t('goals.freeBalanceDeclaredZero')}</Text>
            <IncomeLink />
          </Card>
        );
      }
      return (
        <Card padding="none" style={styles.box}>
          <Text style={styles.line}>
            {t('goals.freeBalanceDeclaredPrefix')} <Text style={styles.amount}>{amount}</Text>{' '}
            {t('goals.freeBalanceDeclaredSuffix')}
          </Text>
          <Text style={styles.muted}>{t('goals.freeBalanceDeclaredBasis')}</Text>
        </Card>
      );
    }

    case 'none':
      return (
        <Card padding="none" style={styles.box}>
          <Text style={styles.title}>{t('goals.freeBalanceNoBasisTitle')}</Text>
          <Text style={styles.line}>{t('goals.freeBalanceNoBasisBody')}</Text>
          <IncomeLink />
        </Card>
      );
  }
}

/**
 * Where the "no basis" / "zero declared" arms send the user: the More tab, which
 * is where the monthly income is entered on this client (web sends them to
 * /settings?focus=income). A route, not a sentence about a screen elsewhere.
 */
function IncomeLink() {
  const t = useT();
  const styles = useStyles();
  return (
    <Pressable
      accessibilityRole="link"
      onPress={() => router.push('/more')}
      style={styles.link}
    >
      <Text style={styles.linkText}>{t('goals.freeBalanceNoBasisLink')}</Text>
    </Pressable>
  );
}

const useStyles = themedStyles((t) => ({
  // `padding="none"` + an explicit pad: the primitive owns the surface, the
  // border and the radius; the widget keeps the tighter inset a phone card needs.
  box: {
    padding: t.spacing.md,
    gap: t.spacing.xs,
  },
  title: {
    fontSize: t.type.md,
    fontWeight: '700',
    color: t.colors.text,
  },
  line: {
    fontSize: t.type.sm,
    color: t.colors.text,
    ...t.tnum,
  },
  amount: {
    fontWeight: '700',
  },
  muted: {
    fontSize: t.type.xs,
    color: t.colors.textMuted,
  },
  link: {
    minHeight: t.TOUCH_TARGET,
    justifyContent: 'center',
  },
  linkText: {
    fontSize: t.type.sm,
    color: t.colors.accent,
    fontWeight: '600',
  },
}));
