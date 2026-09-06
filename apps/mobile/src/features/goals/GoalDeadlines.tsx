// "What's due soon in your plans" (mobile-catchup-3, line C) — the port of web's
// features/goals/plan/GoalDeadlines.tsx, minus the deposits half: this client has
// no deposits screen, so the widget is SELF-CONTAINED and takes no props at all.
//
// Strictly read-only and strictly server-shaped: the rows arrive sorted and
// windowed, so nothing here sorts, filters, groups or totals. A total would be
// cross-currency money arithmetic, which is why each row carries its own currency
// instead.
//
// The BREADCRUMB comes from the server. Building it from the tree would mean
// fetching every goal's plan just to render five lines — and "Hotel" with no
// "Trip → Lodging" above it is unreadable on a screen that is not the plan.
//
// Rendered with a bounded `.map`: the head of an already-sorted server list,
// capped at five, plus a count of what did not fit. This is one of the two cases
// where a map is right — the data cannot grow past the cap.
import { formatApiDate, formatMoney, todayApiDateUtc } from '@budget/shared';
import { router } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { FormButton } from '../../components/FormButton';
import { themedStyles } from '../../theme/themedStyles';
import {
  GOAL_DEADLINE_DAYS,
  useGoalDeadlines,
  type UpcomingDeadlineRead,
} from '../../data/goalDeadlines';
import { useLocale, useT } from '../../i18n/context';

// The row cap. Same shape as the upcoming-charges widget beside it: two widgets
// stacked on somebody else's screen must not each invent their own manners.
const MAX_ROWS = 5;

export function GoalDeadlines() {
  const t = useT();
  const styles = useStyles();
  const query = useGoalDeadlines(GOAL_DEADLINE_DAYS);
  const items = query.data?.items ?? [];
  const rows = items.slice(0, MAX_ROWS);
  const hiddenCount = Math.max(items.length - MAX_ROWS, 0);
  // UTC, because the SERVER decided these dates in UTC: a local-midnight compare
  // badges the wrong row for hours in any offset zone. Two "YYYY-MM-DD" strings
  // compare as dates, so nothing is parsed.
  const today = todayApiDateUtc();

  return (
    <Card padding="none" style={styles.card}>
      <Text style={styles.title}>{t('deadlines.title')}</Text>

      {query.isPending ? (
        // Fixed-height placeholders: the list below must not jump when they land.
        <View style={styles.skeletons}>
          <View style={styles.skeletonRow} />
          <View style={styles.skeletonRow} />
        </View>
      ) : null}

      {query.isError ? (
        <EmptyState
          role="alert"
          title={t('goalDeadlines.loadFailed')}
          style={styles.state}
          action={
            <FormButton
              label={t('common.retry')}
              variant="secondary"
              onPress={() => query.refetch()}
            />
          }
        />
      ) : null}

      {!query.isPending && !query.isError && rows.length === 0 ? (
        <EmptyState
          title={t('deadlines.emptyTitle')}
          description={t('deadlines.emptyBody')}
          style={styles.state}
        />
      ) : null}

      {rows.map((row) => (
        <DeadlineLine key={row.item_id} row={row} today={today} />
      ))}

      {rows.length > 0 || (!query.isPending && !query.isError) ? (
        <Pressable
          accessibilityRole="link"
          onPress={() => router.push('/goals')}
          style={styles.footer}
        >
          <Text style={styles.footerText}>
            {hiddenCount > 0 ? `${t('goalDeadlines.more', { count: hiddenCount })} · ` : ''}
            {t('goalDeadlines.manage')}
          </Text>
        </Pressable>
      ) : null}
    </Card>
  );
}

/** One plan item's line. */
function DeadlineLine({ row, today }: { row: UpcomingDeadlineRead; today: string }) {
  const t = useT();
  const styles = useStyles();
  const locale = useLocale();
  // The date this row is ABOUT — the same anchor the server sorted and windowed
  // by: the reminder when the item has one, else the effective deadline. Both are
  // nullable on the contract; a row with neither cannot be in the window, and if
  // one ever arrives it keeps its name and amount instead of vanishing.
  const anchor = row.reminder_date ?? row.effective_deadline;
  const isToday = anchor === today;
  // The deadline is only worth naming when the row is dated by a REMINDER that
  // falls earlier — otherwise the line already shows it and the suffix would
  // repeat itself.
  const dueDate =
    row.reminder_date !== null &&
    row.effective_deadline !== null &&
    row.effective_deadline !== row.reminder_date
      ? row.effective_deadline
      : null;

  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push({ pathname: '/goal-plan', params: { id: row.goal_id } })}
      style={styles.row}
    >
      <View style={styles.rowText}>
        {/* Goal → ancestors → item, straight from the server. A goal name and an
            item name are USER text: never translated. */}
        <Text style={styles.what} numberOfLines={2}>
          {row.goal_name}
          {row.breadcrumb.map((name) => ` → ${name}`).join('')} → {row.item_name}
        </Text>
        <Text style={styles.when}>
          {anchor === null ? '' : formatApiDate(anchor, { locale })}
          {/* A text badge, not colour alone. */}
          {isToday ? ` · ${t('goalDeadlines.today')}` : ''}
          {dueDate !== null
            ? ` · ${t('goalDeadlines.dueBy', { date: formatApiDate(dueDate, { locale }) })}`
            : ''}
        </Text>
      </View>
      {/* The item's OWN amount in the item's OWN currency (never the goal's,
          never the base — AM-5). An item whose children hold the money has no
          amount of its own and shows none. */}
      {row.amount_minor !== null ? (
        <Text style={styles.amount}>
          {formatMoney(row.amount_minor, row.currency, { locale })}
        </Text>
      ) : null}
    </Pressable>
  );
}

const useStyles = themedStyles((t) => ({
  // `padding="none"` + an explicit pad: the primitive owns the surface, the
  // border and the radius; the widget keeps the tighter inset a phone card needs.
  card: {
    padding: t.spacing.md,
    gap: t.spacing.xs,
  },
  title: {
    fontSize: t.type.md,
    fontWeight: '700',
    color: t.colors.text,
  },
  skeletons: {
    gap: t.spacing.xs,
  },
  skeletonRow: {
    height: 36,
    borderRadius: t.radius.sm,
    backgroundColor: t.colors.surfaceMuted,
  },
  // Inside a widget the shared state box does not need its own screen-sized
  // padding: the card already provides it.
  state: {
    paddingVertical: t.spacing.sm,
    paddingHorizontal: 0,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.sm,
    minHeight: t.TOUCH_TARGET,
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  what: {
    fontSize: t.type.sm,
    color: t.colors.text,
  },
  when: {
    fontSize: t.type.xs,
    color: t.colors.textMuted,
  },
  amount: {
    fontSize: t.type.sm,
    fontWeight: '600',
    color: t.colors.text,
    ...t.tnum,
  },
  footer: {
    minHeight: t.TOUCH_TARGET,
    justifyContent: 'center',
  },
  footerText: {
    fontSize: t.type.sm,
    color: t.colors.accent,
    fontWeight: '600',
  },
}));
