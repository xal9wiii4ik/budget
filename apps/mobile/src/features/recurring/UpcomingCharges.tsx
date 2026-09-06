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
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, spacing, TOUCH_TARGET } from '../../components/theme';
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
    <View style={styles.card}>
      <Text style={styles.title}>{t('upcoming.title')}</Text>

      {query.isPending ? (
        // Fixed-height placeholders: the list below must not jump when they land.
        <View style={styles.skeletons}>
          <View style={styles.skeletonRow} />
          <View style={styles.skeletonRow} />
        </View>
      ) : query.isError ? (
        <View style={styles.errorBox}>
          <Text accessibilityRole="alert" style={styles.errorText}>
            {t('upcoming.loadFailed')}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => query.refetch()}
            hitSlop={8}
            style={styles.retry}
          >
            <Text style={styles.link}>{t('common.retry')}</Text>
          </Pressable>
        </View>
      ) : rows.length === 0 ? (
        // Says what to do next, and where — an empty widget that only says "none"
        // teaches the user nothing about why it exists.
        <View style={styles.emptyBox}>
          <Text style={styles.empty}>
            {t('upcoming.emptyTitle')} {t('upcoming.emptyBody')}
          </Text>
          <Pressable accessibilityRole="link" onPress={openRecurring} hitSlop={8}>
            <Text style={styles.link}>{t('upcoming.manage')}</Text>
          </Pressable>
        </View>
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
                  <Text style={styles.todayBadge}>{t('upcoming.today')}</Text>
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
            <Pressable accessibilityRole="link" onPress={openRecurring} hitSlop={8}>
              <Text style={styles.link}>{t('upcoming.manage')}</Text>
            </Pressable>
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  title: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
  },
  skeletons: {
    gap: spacing.xs,
  },
  skeletonRow: {
    height: 20,
    borderRadius: 6,
    backgroundColor: colors.border,
  },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  errorText: {
    flex: 1,
    fontSize: 13,
    color: colors.danger,
  },
  retry: {
    minHeight: TOUCH_TARGET - 12,
    justifyContent: 'center',
  },
  emptyBox: {
    gap: spacing.xs,
  },
  empty: {
    fontSize: 13,
    color: colors.textMuted,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  rowToday: {
    backgroundColor: '#F0F6FF',
    borderRadius: 6,
    paddingHorizontal: spacing.xs,
  },
  when: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  date: {
    fontSize: 13,
    color: colors.textMuted,
  },
  todayBadge: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.primary,
    backgroundColor: '#E7F1FD',
    borderRadius: 5,
    paddingHorizontal: spacing.xs,
    overflow: 'hidden',
  },
  name: {
    flex: 1,
    fontSize: 14,
    color: colors.text,
  },
  amount: {
    fontSize: 14,
    fontWeight: '600',
  },
  expense: {
    color: colors.expense,
  },
  income: {
    color: colors.income,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingTop: spacing.xs,
  },
  more: {
    fontSize: 12,
    color: colors.textMuted,
  },
  link: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.primary,
  },
});
