// Month transaction list. Long-list rule (agent): a SectionList (never .map in a
// ScrollView), day-grouped via groupByDay (preserves server occurred_at-DESC order,
// no re-sort), keyExtractor by id, memoized rows. onEndReached drives load-more; the
// footer shows "Showing N of total". Handles loading / empty / error / success.
import { formatApiDate } from '@budget/shared';
import type { components } from '@budget/api-client';
import { useMemo } from 'react';
import { ActivityIndicator, SectionList, StyleSheet, Text, View } from 'react-native';

import { FormButton } from '../../components/FormButton';
import { colors, spacing } from '../../components/theme';
import { APP_LOCALE } from '../../lib/locale';
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
  onLoadMore,
  onRetry,
  onRefresh,
  onEdit,
  onAddFirst,
}: TransactionListProps) {
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
          Couldn&apos;t load transactions.
        </Text>
        <FormButton label="Retry" variant="secondary" onPress={onRetry} />
      </View>
    );
  }

  if (transactions.length === 0) {
    return (
      <View style={styles.stateBox}>
        <Text style={styles.emptyText}>No transactions in {monthLabel}. Add your first one.</Text>
        <FormButton label="Add transaction" onPress={onAddFirst} />
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
          {formatApiDate((section as DaySection).date, { locale: APP_LOCALE })}
        </Text>
      )}
      renderItem={({ item }) => (
        <TransactionRow
          transaction={item}
          category={item.category_id ? categoryIndex.get(item.category_id) : undefined}
          onEdit={onEdit}
        />
      )}
      ItemSeparatorComponent={() => <View style={styles.separator} />}
      ListFooterComponent={
        <View style={styles.footer}>
          <Text style={styles.count}>
            Showing {transactions.length} of {total}
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
