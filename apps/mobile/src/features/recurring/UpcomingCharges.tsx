// "What's coming" — the charges the user's live templates still owe in the next 30
// days (catch-up 3, line B; web's UpcomingCharges without the book-now "+", which
// belongs to a scope of its own).
//
// SELF-CONTAINED on purpose: it takes no props, so the transactions tab mounts it
// with one line and owns nothing about it. Strictly READ-ONLY and strictly
// server-shaped — the rows arrive already sorted and already filtered to "not yet
// materialized AND due today or later", so this component sorts nothing, groups
// nothing and totals nothing. A total would be cross-currency money arithmetic,
// and each row is stamped with its template's OWN currency precisely so it does
// not need one.
//
// It is a secondary panel on somebody else's screen, so its failure and loading
// arms are compact: it must not shout over the transaction list below it.
import { formatApiDate, formatMoney, todayApiDateUtc } from '@budget/shared';
import { router } from 'expo-router';
import { Text, View } from 'react-native';

import { Badge } from '../../components/Badge';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { FormButton } from '../../components/FormButton';
import { themedStyles } from '../../theme/themedStyles';
import { useUpcomingCharges } from '../../data/recurring';
import { useLocale, useT } from '../../i18n/context';
import { upcomingRows } from './upcomingRows';

// The contract default (`ge=1 le=90`) and the row cap. Constants rather than
// props: there is one caller and no horizon control — `days` is already in the
// cache key, so adding one later is a parameter change, not a cache redesign.
const HORIZON_DAYS = 30;
const MAX_ROWS = 5;

export function UpcomingCharges() {
  const t = useT();
  const styles = useStyles();
  const locale = useLocale();
  const query = useUpcomingCharges(HORIZON_DAYS);

  // UTC, because the SERVER decided these dates in UTC (`_today()`): a
  // local-midnight compare would badge the wrong row for hours in any offset zone.
  const { rows, hiddenCount } = upcomingRows(query.data?.items ?? [], {
    max: MAX_ROWS,
    today: todayApiDateUtc(),
  });

  const openRecurring = () => router.push('/recurring');

  return (
    // `padding="none"` + the widget's own padding below: this panel is tighter
    // than a full-screen card, and the Card is here for the surface and the
    // border, not for a screen's rhythm.
    <Card padding="none" style={styles.card}>
      <Text style={styles.title}>{t('upcoming.title')}</Text>

      {query.isPending ? (
        // Fixed-height placeholders: the list below must not jump when they land.
        <View style={styles.skeletons}>
          <View style={styles.skeletonRow} />
          <View style={styles.skeletonRow} />
        </View>
      ) : query.isError ? (
        <EmptyState
          role="alert"
          title={t('upcoming.loadFailed')}
          style={styles.stateBox}
          action={
            <FormButton
              label={t('common.retry')}
              variant="ghost"
              size="sm"
              onPress={() => query.refetch()}
            />
          }
        />
      ) : rows.length === 0 ? (
        // Says what to do next, and where — an empty widget that only says "none"
        // teaches the user nothing about why it exists.
        <EmptyState
          title={t('upcoming.emptyTitle')}
          description={t('upcoming.emptyBody')}
          style={styles.stateBox}
          action={
            <FormButton
              label={t('upcoming.manage')}
              variant="ghost"
              size="sm"
              onPress={openRecurring}
            />
          }
        />
      ) : (
        <>
          {rows.map(({ charge, isToday }) => (
            // A template legitimately appears several times inside 30 days, so the
            // identity of a ROW is the template AND the date — never an index.
            <View
              key={`${charge.template_id}:${charge.due_on}`}
              style={[styles.row, isToday && styles.rowToday]}
            >
              <View style={styles.when}>
                <Text style={styles.date}>
                  {formatApiDate(charge.due_on, { locale })}
                </Text>
                {isToday ? (
                  // A text badge, not colour alone: "charges today" has to read at
                  // a glance and survive a monochrome screen.
                  <Badge label={t('upcoming.today')} tone="accent" />
                ) : null}
              </View>
              <Text style={styles.name} numberOfLines={1}>
                {charge.name}
              </Text>
              <Text
                style={[
                  styles.amount,
                  charge.kind === 'expense' ? styles.expense : styles.income,
                ]}
              >
                {/* The TemplateRow convention: sign from `kind`, amount in the
                    row's own stamped currency, never the profile base. */}
                {formatMoney(
                  charge.kind === 'expense' ? -charge.amount_minor : charge.amount_minor,
                  charge.currency,
                  { locale },
                )}
              </Text>
            </View>
          ))}
          <View style={styles.footer}>
            {hiddenCount > 0 ? (
              <Text style={styles.more}>{t('upcoming.more', { count: hiddenCount })}</Text>
            ) : null}
            <FormButton
              label={t('upcoming.manage')}
              variant="ghost"
              size="sm"
              onPress={openRecurring}
              style={styles.manage}
            />
          </View>
        </>
      )}
    </Card>
  );
}

const useStyles = themedStyles((t) => ({
  card: {
    marginHorizontal: t.spacing.lg,
    marginBottom: t.spacing.md,
    padding: t.spacing.md,
    gap: t.spacing.xs,
  },
  title: {
    fontSize: t.type.sm,
    fontWeight: '700',
    color: t.colors.textMuted,
    textTransform: 'uppercase',
  },
  skeletons: {
    gap: t.spacing.xs,
  },
  skeletonRow: {
    height: 20,
    borderRadius: t.radius.sm,
    backgroundColor: t.colors.surfaceMuted,
  },
  // The shared empty/error box, trimmed: this is a secondary panel on somebody
  // else's screen and must not shout over the transaction list below it.
  stateBox: {
    paddingHorizontal: 0,
    paddingVertical: t.spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.sm,
    paddingVertical: t.spacing.xs,
  },
  rowToday: {
    backgroundColor: t.colors.accentSoft,
    borderRadius: t.radius.sm,
    paddingHorizontal: t.spacing.xs,
  },
  when: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.xs,
  },
  date: {
    fontSize: t.type.sm,
    color: t.colors.textMuted,
  },
  name: {
    flex: 1,
    fontSize: t.type.sm,
    color: t.colors.text,
  },
  amount: {
    fontSize: t.type.sm,
    fontWeight: '600',
    ...t.tnum,
  },
  expense: {
    color: t.colors.expense,
  },
  income: {
    color: t.colors.income,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: t.spacing.sm,
    paddingTop: t.spacing.xs,
  },
  more: {
    fontSize: t.type.xs,
    color: t.colors.textMuted,
  },
  // A ghost button brings its own accent label; only the box padding has to go,
  // so the action still sits flush with the widget's right edge.
  manage: {
    paddingHorizontal: 0,
  },
}));
