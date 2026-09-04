// Month transaction list. Long-list rule (agent): a SectionList (never .map in a
// ScrollView), day-grouped via groupByDay (preserves server occurred_at-DESC order,
// no re-sort), keyExtractor by id, memoized rows. onEndReached drives load-more; the
// footer shows "Showing N of total". Handles loading / empty / error / success.
import { formatApiDate, sentenceEnd } from '@budget/shared';
import type { components } from '@budget/api-client';
import { useMemo } from 'react';
import { ActivityIndicator, SectionList, StyleSheet, Text, View } from 'react-native';

import { FormButton } from '../../components/FormButton';
import { colors, spacing } from '../../components/theme';
import type { AccountRead } from '../../data/accounts';
import { useLocale, useT } from '../../i18n/context';
import { groupByDay } from './groupByDay';
import { TransactionRow } from './TransactionRow';

type CategoryRead = components['schemas']['CategoryRead'];
type TransactionRead = components['schemas']['TransactionRead'];

interface TransactionListProps {
  transactions: TransactionRead[];
  total: number;
  status: 'pending' | 'error' | 'success';
  hasMore: boolean;
  isLoadingMore: boolean;
  isRefreshing: boolean;
  monthLabel: string;
  categoryIndex: Map<string, CategoryRead>;
  // accounts-and-transfers MOB: passed straight to the rows — the transfer arm
  // joins the two account NAMES, and `viewAccountId` (the active account filter)
  // decides which leg of a transfer this list is showing.
  accountsById: Map<string, AccountRead>;
  viewAccountId: string | undefined;
  onLoadMore: () => void;
  onRetry: () => void;
  onRefresh: () => void;
  onEdit: (transaction: TransactionRead) => void;
  onAddFirst: () => void;
}

interface DaySection {
  date: string;
  data: TransactionRead[];
}

export function TransactionList({
  transactions,
  total,
  status,
  hasMore,
  isLoadingMore,
  isRefreshing,
  monthLabel,
  categoryIndex,
  accountsById,
  viewAccountId,
  onLoadMore,
  onRetry,
  onRefresh,
  onEdit,
  onAddFirst,
}: TransactionListProps) {
  const t = useT();
  const locale = useLocale();

  const sections = useMemo<DaySection[]>(
    () => groupByDay(transactions).map((group) => ({ date: group.date, data: group.items })),
    [transactions],
  );

  if (status === 'pending') {
    return (
      <View style={styles.stateBox}>
        {[0, 1, 2, 3].map((i) => (
          <View key={i} style={styles.skeletonRow} />
        ))}
      </View>
    );
  }

  if (status === 'error') {
    return (
      <View style={styles.stateBox}>
        <Text accessibilityRole="alert" style={styles.error}>
          {t('tx.loadFailed')}
        </Text>
        <FormButton label={t('common.retry')} variant="secondary" onPress={onRetry} />
      </View>
    );
  }

  if (transactions.length === 0) {
    return (
      <View style={styles.stateBox}>
        {/* F-4: ru month labels already end in '.' ("август 2026 г.") — sentenceEnd
            terminates the sentence without doubling the period. */}
        <Text style={styles.emptyText}>
          {sentenceEnd(t('tx.emptyMonth', { month: monthLabel }))} {t('tx.emptyMonthCta')}
        </Text>
        <FormButton label={t('tx.add')} onPress={onAddFirst} />
      </View>
    );
  }

  return (
    <SectionList
      sections={sections}
      keyExtractor={(item) => item.id}
      stickySectionHeadersEnabled={false}
      onRefresh={onRefresh}
      refreshing={isRefreshing}
      onEndReachedThreshold={0.4}
      onEndReached={() => {
        if (hasMore && !isLoadingMore) onLoadMore();
      }}
      renderSectionHeader={({ section }) => (
        <Text style={styles.dayLabel}>
          {formatApiDate((section as DaySection).date, { locale })}
        </Text>
      )}
      renderItem={({ item }) => (
        <TransactionRow
          transaction={item}
          category={item.category_id ? categoryIndex.get(item.category_id) : undefined}
          accountsById={accountsById}
          viewAccountId={viewAccountId}
          onEdit={onEdit}
        />
      )}
      ItemSeparatorComponent={() => <View style={styles.separator} />}
      ListFooterComponent={
        <View style={styles.footer}>
          <Text style={styles.count}>
            {t('tx.showing', { shown: transactions.length, total })}
          </Text>
          {isLoadingMore ? <ActivityIndicator color={colors.primary} /> : null}
        </View>
      }
      contentContainerStyle={styles.listContent}
    />
  );
}

const styles = StyleSheet.create({
  stateBox: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  skeletonRow: {
    height: 52,
    borderRadius: 8,
    backgroundColor: colors.border,
  },
  error: {
    color: colors.danger,
    fontSize: 14,
  },
  emptyText: {
    color: colors.textMuted,
    fontSize: 15,
    textAlign: 'center',
  },
  listContent: {
    paddingBottom: spacing.xl,
  },
  dayLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textMuted,
    backgroundColor: colors.bg,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
  },
  separator: {
    height: 1,
    backgroundColor: colors.border,
    marginLeft: spacing.lg,
  },
  footer: {
    padding: spacing.lg,
    alignItems: 'center',
    gap: spacing.sm,
  },
  count: {
    color: colors.textMuted,
    fontSize: 13,
  },
});
