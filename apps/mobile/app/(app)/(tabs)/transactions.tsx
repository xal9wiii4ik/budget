import { currentMonth, formatMonthLabel, monthBounds } from '@budget/shared';
import type { components } from '@budget/api-client';
import { router } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAccounts } from '../../../src/data/accounts';
import { buildAccountIndex, sortForDisplay } from '../../../src/data/accountLookup';
import { buildCategoryIndex } from '../../../src/data/categoryLookup';
import { useCategories } from '../../../src/data/categories';
import { AccountFilter } from '../../../src/features/accounts/AccountFilter';
import { MONTH_LIMIT, useSummary, useTransactions } from '../../../src/data/transactions';
import type { TxListFilters } from '../../../src/data/queryKeys';
import { MonthPicker } from '../../../src/features/transactions/MonthPicker';
import { SummaryHeader } from '../../../src/features/transactions/SummaryHeader';
import { TransactionList } from '../../../src/features/transactions/TransactionList';
import { colors, spacing, TOUCH_TARGET } from '../../../src/components/theme';
import { useLocale, useT } from '../../../src/i18n/context';

type TransactionRead = components['schemas']['TransactionRead'];

export default function TransactionsScreen() {
  const t = useT();
  // Every formatter below takes the INTERFACE language's locale, never the host
  // default (the "English UI, Russian dates" defect).
  const locale = useLocale();
  // Month is local state seeded from the current month — deep-link-safe (no reliance
  // on another screen's state). The account filter is local state for the same
  // reason (accounts-and-transfers MOB).
  const [month, setMonth] = useState(() => currentMonth());
  const [accountId, setAccountId] = useState<string | null>(null);

  const bounds = monthBounds(month);
  // The account member is OMITTED, not set to `undefined`, when nothing is
  // filtered: the unfiltered key stays byte-identical to the one this screen has
  // always used, so no shipped cache entry is invalidated by this feature.
  const filters: TxListFilters =
    accountId === null
      ? { from: bounds.from, to: bounds.to, limit: MONTH_LIMIT }
      : { from: bounds.from, to: bounds.to, account_id: accountId, limit: MONTH_LIMIT };

  const txQuery = useTransactions(filters);
  const summaryQuery = useSummary(month);
  const categoriesQuery = useCategories();
  // One 60s-cached read feeding two things at once: the filter's options and the
  // transfer rows' "A → B" names.
  const accountsQuery = useAccounts();

  const categoryIndex = useMemo(
    () => buildCategoryIndex(categoriesQuery.data ?? []),
    [categoriesQuery.data],
  );
  const accountsById = useMemo(
    () => buildAccountIndex(accountsQuery.data ?? []),
    [accountsQuery.data],
  );
  const filterAccounts = useMemo(
    () => (accountsQuery.data ? sortForDisplay(accountsQuery.data, locale) : []),
    [accountsQuery.data, locale],
  );

  const transactions = txQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const total = txQuery.data?.pages[0]?.total ?? 0;
  const monthLabel = formatMonthLabel(month, { locale });

  const openCreate = () => router.push({ pathname: '/transaction-form', params: { month } });
  const openCreateTransfer = () =>
    router.push({ pathname: '/transfer-form', params: { month } });
  // Stable identity so the memoized TransactionRow isn't re-rendered on every screen
  // render (NIT 8); only re-created when the month it captures changes.
  //
  // A transfer is edited by its OWN form (A1) — one operation, one form, both
  // sides — so the row's kind decides the route.
  const openEdit = useCallback(
    (transaction: TransactionRead) =>
      router.push({
        pathname: transaction.kind === 'transfer' ? '/transfer-form' : '/transaction-form',
        params: { month, id: transaction.id },
      }),
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
          accessibilityLabel={t('tx.addTransfer')}
          onPress={openCreateTransfer}
          style={styles.transferButton}
        >
          <Text style={styles.transferButtonText}>⇄</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('tx.add')}
          onPress={openCreate}
          style={styles.addButton}
        >
          <Text style={styles.addButtonText}>＋</Text>
        </Pressable>
      </View>

      <AccountFilter value={accountId} accounts={filterAccounts} onChange={setAccountId} />

      <SummaryHeader
        summaryQuery={summaryQuery}
        categoryIndex={categoryIndex}
        onRetry={() => summaryQuery.refetch()}
      />

      {/* The summary above is account-agnostic (GET /transactions/summary takes no
          account), so saying "only" without that caveat would invite reading those
          totals as this account's. */}
      {accountId !== null ? (
        <Text style={styles.filterNotice}>
          {t('tx.filterNotice', {
            // The account NAME is the user's own text and is never translated;
            // only the fallback for a name we have not loaded is copy.
            account: accountsById.get(accountId)?.name ?? t('tx.filterOneAccount'),
          })}
        </Text>
      ) : null}

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
          accountsById={accountsById}
          viewAccountId={accountId ?? undefined}
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
  transferButton: {
    width: TOUCH_TARGET,
    height: TOUCH_TARGET,
    borderRadius: TOUCH_TARGET / 2,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  transferButtonText: {
    color: colors.primary,
    fontSize: 20,
    lineHeight: 24,
  },
  filterNotice: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
    fontSize: 13,
    color: colors.textMuted,
  },
  listWrap: {
    flex: 1,
  },
});
