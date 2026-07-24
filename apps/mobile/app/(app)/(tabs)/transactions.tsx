import { currentMonth, formatMonthLabel, monthBounds } from '@budget/shared';
import type { components } from '@budget/api-client';
import { router } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { buildCategoryIndex } from '../../../src/data/categoryLookup';
import { useCategories } from '../../../src/data/categories';
import { MONTH_LIMIT, useSummary, useTransactions } from '../../../src/data/transactions';
import type { TxListFilters } from '../../../src/data/queryKeys';
import { MonthPicker } from '../../../src/features/transactions/MonthPicker';
import { SummaryHeader } from '../../../src/features/transactions/SummaryHeader';
import { TransactionList } from '../../../src/features/transactions/TransactionList';
import { colors, spacing, TOUCH_TARGET } from '../../../src/components/theme';
import { APP_LOCALE } from '../../../src/lib/locale';

type TransactionRead = components['schemas']['TransactionRead'];

export default function TransactionsScreen() {
  // Month is local state seeded from the current month — deep-link-safe (no reliance
  // on another screen's state).
  const [month, setMonth] = useState(() => currentMonth());

  const bounds = monthBounds(month);
  const filters: TxListFilters = { from: bounds.from, to: bounds.to, limit: MONTH_LIMIT };

  const txQuery = useTransactions(filters);
  const summaryQuery = useSummary(month);
  const categoriesQuery = useCategories();

  const categoryIndex = useMemo(
    () => buildCategoryIndex(categoriesQuery.data ?? []),
    [categoriesQuery.data],
  );

  const transactions = txQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const total = txQuery.data?.pages[0]?.total ?? 0;
  const monthLabel = formatMonthLabel(month, { locale: APP_LOCALE });

  const openCreate = () => router.push({ pathname: '/transaction-form', params: { month } });
  // Stable identity so the memoized TransactionRow isn't re-rendered on every screen
  // render (NIT 8); only re-created when the month it captures changes.
  const openEdit = useCallback(
    (transaction: TransactionRead) =>
      router.push({ pathname: '/transaction-form', params: { month, id: transaction.id } }),
    [month],
  );

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <View style={styles.toolbar}>
        <View style={styles.monthWrap}>
          <MonthPicker month={month} onChange={setMonth} />
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add transaction"
          onPress={openCreate}
          style={styles.addButton}
        >
          <Text style={styles.addButtonText}>＋</Text>
        </Pressable>
      </View>

      <SummaryHeader
        summaryQuery={summaryQuery}
        categoryIndex={categoryIndex}
        onRetry={() => summaryQuery.refetch()}
      />

      <View style={styles.listWrap}>
        <TransactionList
          transactions={transactions}
          total={total}
          status={txQuery.status}
          hasMore={txQuery.hasNextPage}
          isLoadingMore={txQuery.isFetchingNextPage}
          isRefreshing={txQuery.isRefetching && !txQuery.isFetchingNextPage}
          monthLabel={monthLabel}
          categoryIndex={categoryIndex}
          onLoadMore={() => txQuery.fetchNextPage()}
          onRetry={() => txQuery.refetch()}
          onRefresh={() => txQuery.refetch()}
          onEdit={openEdit}
          onAddFirst={openCreate}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    gap: spacing.md,
  },
  monthWrap: {
    flex: 1,
  },
  addButton: {
    width: TOUCH_TARGET,
    height: TOUCH_TARGET,
    borderRadius: TOUCH_TARGET / 2,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addButtonText: {
    color: '#FFFFFF',
    fontSize: 24,
    lineHeight: 28,
  },
  listWrap: {
    flex: 1,
  },
});
