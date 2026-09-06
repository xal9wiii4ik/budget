import { currentMonth, formatApiDate, formatMonthLabel } from '@budget/shared';
import type { components } from '@budget/api-client';
import { router } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAccounts } from '../../../src/data/accounts';
import { buildAccountIndex, sortForDisplay } from '../../../src/data/accountLookup';
import { buildCategoryIndex, sortForDisplay as sortCategories } from '../../../src/data/categoryLookup';
import { useCategories } from '../../../src/data/categories';
import { AccountFilter } from '../../../src/features/accounts/AccountFilter';
import { GoalDeadlines } from '../../../src/features/goals/GoalDeadlines';
import { UpcomingCharges } from '../../../src/features/recurring/UpcomingCharges';
import { useSummary, useTransactions } from '../../../src/data/transactions';
import type { TxSort } from '../../../src/data/queryKeys';
import { MonthPicker } from '../../../src/features/transactions/MonthPicker';
import { SummaryHeader } from '../../../src/features/transactions/SummaryHeader';
import { TransactionList } from '../../../src/features/transactions/TransactionList';
import { TxFilterChips } from '../../../src/features/transactions/TxFilterChips';
import { TxFiltersSheet } from '../../../src/features/transactions/TxFiltersSheet';
import { TxSearchField } from '../../../src/features/transactions/TxSearchField';
import {
  activeFilterCount,
  isNarrowed,
  showsDayGroups,
  TX_LIST_LIMIT,
  txListFilters,
  type TxRangeMode,
  type TxSelection,
} from '../../../src/features/transactions/txFilters';
import { colors, spacing, TOUCH_TARGET } from '../../../src/components/theme';
import { countryLabel } from '../../../src/lib/countryLabel';
import { useDebouncedValue } from '../../../src/lib/useDebouncedValue';
import { useLocale, useT } from '../../../src/i18n/context';

type TransactionRead = components['schemas']['TransactionRead'];

// How long the search box stays quiet before its value reaches the query key. Long
// enough that a typed word is ONE request, short enough that the list feels live —
// and it is the debounced value alone that becomes a cache entry.
const SEARCH_DEBOUNCE_MS = 350;

export default function TransactionsScreen() {
  const t = useT();
  // Every formatter below takes the INTERFACE language's locale, never the host
  // default (the "English UI, Russian dates" defect).
  const locale = useLocale();
  // The whole filter set is LOCAL STATE. Web keeps it in the URL so a slice is
  // shareable and the back button undoes it; a phone screen has neither, and the
  // tab is deep-linked with no parameters at all — so every member below is seeded
  // from something this screen knows on its own, which keeps it deep-link-safe.
  const [month, setMonth] = useState(() => currentMonth());
  // The month the stepper is on is kept even while all-time or a custom period is in
  // force, so leaving either mode returns to the month that was being read.
  const [mode, setMode] = useState<TxRangeMode>(() => ({ kind: 'month', month: currentMonth() }));
  const [accountId, setAccountId] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [country, setCountry] = useState<string | null>(null);
  const [sort, setSort] = useState<TxSort | null>(null);
  // The RAW typed text; only the debounced, trimmed value below is data in the key.
  const [searchText, setSearchText] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);

  const debouncedSearch = useDebouncedValue(searchText, SEARCH_DEBOUNCE_MS);
  const trimmedSearch = debouncedSearch.trim();

  const selection: TxSelection = {
    mode,
    accountId,
    categoryId,
    // An all-whitespace search is no search — the same rule web's URL parser applies.
    q: trimmedSearch === '' ? null : trimmedSearch,
    country,
    sort,
  };
  const filters = txListFilters(selection, TX_LIST_LIMIT);
  const narrowed = isNarrowed(selection);
  const grouped = showsDayGroups(sort);

  const txQuery = useTransactions(filters);
  // The summary is a MONTH aggregate and takes no other filter, so it is only
  // RENDERED in month mode (below) — but the query keeps running in every mode:
  // `summary.currency` is the profile base currency the rows need for their "≈"
  // line, and it is one cached request either way.
  const summaryQuery = useSummary(month);
  const categoriesQuery = useCategories();
  // One 60s-cached read feeding three things at once: the filter's options, the
  // transfer rows' "A → B" names and the account chip's name.
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
  const filterCategories = useMemo(
    () => (categoriesQuery.data ? sortCategories(categoriesQuery.data, locale) : []),
    [categoriesQuery.data, locale],
  );

  const transactions = txQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const total = txQuery.data?.pages[0]?.total ?? 0;
  // What the list is showing, in words. In a custom period it names the PERIOD:
  // "no transactions in August" would be false about three days in July.
  const periodLabel =
    mode.kind === 'custom'
      ? t('tx.rangeLabel', {
          from: formatApiDate(mode.from, { locale }),
          to: formatApiDate(mode.to, { locale }),
        })
      : formatMonthLabel(month, { locale });

  // The filtered account's NAME, or the fallback while the list is loading, errored
  // or does not know that id — the chip then says "one account" rather than naming
  // one we cannot vouch for.
  const accountName =
    accountId === null ? null : (accountsById.get(accountId)?.name ?? t('tx.filterOneAccount'));
  // Same rule off the archived-INCLUSIVE index: a since-archived category still
  // resolves to its own name, flagged, instead of reading as an unfiltered list.
  const filteredCategory = categoryId === null ? undefined : categoryIndex.get(categoryId);
  const categoryName =
    categoryId === null
      ? null
      : filteredCategory === undefined
        ? t('tx.filterOneCategory')
        : filteredCategory.archived
          ? `${filteredCategory.name} ${t('common.archivedParens')}`
          : filteredCategory.name;
  const countryName = country === null ? null : countryLabel(locale, country);

  const openCreate = () => router.push({ pathname: '/transaction-form', params: { month } });
  const openCreateTransfer = () =>
    router.push({ pathname: '/transfer-form', params: { month } });
  // Stable identity so the memoized TransactionRow isn't re-rendered on every screen
  // render (NIT 8).
  //
  // A transfer is edited by its OWN form (A1) — one operation, one form, both sides
  // — so the row's kind decides the route.
  //
  // THE MONTH IS THE ROW'S, not the screen's. There is no `GET /transactions/{id}`:
  // both forms locate their edit row inside the cached, UNFILTERED
  // `{from,to,limit:MONTH_LIMIT}` list of the month they are handed. Under an
  // all-time or custom window — or simply a filtered month — the screen's `month`
  // may be a month the row does not belong to, and the form would open on
  // "unavailable". `occurred_at` is date-only, so its first seven characters ARE the
  // month bucket.
  const openEdit = useCallback(
    (transaction: TransactionRead) =>
      router.push({
        pathname: transaction.kind === 'transfer' ? '/transfer-form' : '/transaction-form',
        params: { month: transaction.occurred_at.slice(0, 7), id: transaction.id },
      }),
    [],
  );

  // The one writer of the range: the three modes are mutually exclusive, and month
  // mode also moves the stepper so the two never disagree.
  const onModeChange = (next: TxRangeMode) => {
    setMode(next);
    if (next.kind === 'month') setMonth(next.month);
  };
  const onMonthChange = (next: string) => {
    setMonth(next);
    setMode({ kind: 'month', month: next });
  };

  // Left to the React Compiler to memoize (a hand-written useMemo here is rejected
  // by `react-hooks/preserve-manual-memoization`): typing in the search box
  // re-renders this screen on every keystroke, and the widgets depend on none of it.
  const widgets = narrowed ? undefined : (
    <>
      {/* The deadlines card carries no margins of its own (it is also used inside a
          screen that supplies them), so it gets the same inset as the charges card
          below it. */}
      <View style={styles.widgetWrap}>
        <GoalDeadlines />
      </View>
      <UpcomingCharges />
    </>
  );

  // GET /transactions/summary is a MONTH aggregate and takes no other filter, so it
  // has nothing to say about an all-time list — showing one month's totals above
  // every transaction ever would read as their sum. A custom period is the same
  // situation for the same reason.
  //
  // DEFECT (real device, many categories): the card is UNBOUNDED — one breakdown row
  // per category with activity in the month — and it used to be a fixed sibling ABOVE
  // the `flex: 1` list. RN's default `flexShrink` is 0, so on a real month (20-odd
  // categories) the card claimed the whole viewport, the list under it measured zero
  // and the screen could not be scrolled at all: the rows were unreachable and the
  // breakdown itself was cut off at the tab bar. It rides inside the list header now,
  // exactly like the two widgets, so the summary, the widgets and the rows scroll as
  // ONE column and every height is bounded by the list's own scroll view.
  const summaryCard =
    mode.kind === 'month' ? (
      <View style={styles.summaryWrap}>
        <SummaryHeader
          summaryQuery={summaryQuery}
          categoryIndex={categoryIndex}
          onRetry={() => summaryQuery.refetch()}
        />
      </View>
    ) : null;

  // One node for the list to render above the rows AND above every non-success arm.
  // `undefined` when there is nothing at all, so the list keeps its bare shape.
  const listHeader =
    summaryCard === null && widgets === undefined ? undefined : (
      <>
        {summaryCard}
        {widgets}
      </>
    );

  const clearSearchAndFilters = () => {
    setSearchText('');
    setCategoryId(null);
    setCountry(null);
  };

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <View style={styles.toolbar}>
        <View style={styles.monthWrap}>
          {/* Only ONE window is ever claimed at a time: a stepper that quietly did
              nothing under all-time or a custom period would be the worse lie. */}
          {mode.kind === 'month' ? (
            <MonthPicker month={month} onChange={onMonthChange} />
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('tx.rangeBackToMonth')}
              onPress={() => onModeChange({ kind: 'month', month })}
              style={styles.rangeLabelButton}
            >
              <Text style={styles.rangeLabel} numberOfLines={1}>
                {mode.kind === 'all' ? t('tx.rangeAllTime') : periodLabel}
              </Text>
              <Text style={styles.rangeBack}>{t('tx.rangeBackToMonth')}</Text>
            </Pressable>
          )}
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

      <View style={styles.searchRow}>
        <View style={styles.searchWrap}>
          <TxSearchField value={searchText} onChange={setSearchText} />
        </View>
        <Pressable
          accessibilityRole="button"
          // The badge is a bare number next to a word; the announced name spells the
          // count out, because "Filters 2" is not a sentence.
          accessibilityLabel={
            activeFilterCount(selection) > 0
              ? `${t('tx.filters')}, ${t('tx.filtersActive', { count: activeFilterCount(selection) })}`
              : t('tx.filters')
          }
          onPress={() => setFiltersOpen(true)}
          style={[styles.filtersButton, activeFilterCount(selection) > 0 && styles.filtersActive]}
        >
          <Text
            style={[
              styles.filtersButtonText,
              activeFilterCount(selection) > 0 && styles.filtersActiveText,
            ]}
          >
            {t('tx.filters')}
            {activeFilterCount(selection) > 0 ? ` ${activeFilterCount(selection)}` : ''}
          </Text>
        </Pressable>
      </View>

      <AccountFilter value={accountId} accounts={filterAccounts} onChange={setAccountId} />

      <TxFilterChips
        accountName={accountName}
        onClearAccount={() => setAccountId(null)}
        categoryName={categoryName}
        onClearCategory={() => setCategoryId(null)}
        countryName={countryName}
        onClearCountry={() => setCountry(null)}
        // The caveat belongs to the totals; in the two other modes there are none.
        summaryOnScreen={mode.kind === 'month' && narrowed}
      />

      <View style={styles.listWrap}>
        <TransactionList
          // THE MONTH SUMMARY, then THE WIDGETS (catch-up 3). They ride inside the
          // list rather than sitting above it: cards pinned over a phone viewport
          // would leave the transactions themselves a strip at the bottom — or, with
          // a real month's breakdown, no strip at all (see `summaryCard` above) — so
          // they scroll away with the first flick. Web's order — summary, deadlines,
          // charges.
          //
          // The widgets' gate is `narrowed` (isNarrowed): both read templates and
          // plan items, which carry no note, no country, no account and no
          // category, so they cannot honestly answer any of the filters above and a
          // half-filtered widget lies. A wider set (all-time) or a mere re-sort
          // keeps them on screen.
          header={listHeader}
          transactions={transactions}
          total={total}
          status={txQuery.status}
          hasMore={txQuery.hasNextPage}
          isLoadingMore={txQuery.isFetchingNextPage}
          isRefreshing={txQuery.isRefetching && !txQuery.isFetchingNextPage}
          periodLabel={periodLabel}
          categoryIndex={categoryIndex}
          accountsById={accountsById}
          viewAccountId={accountId ?? undefined}
          // The rows' "≈ base" line needs the base currency, and only a summary that
          // is ON SCREEN vouches for it being the current one.
          summaryCurrency={mode.kind === 'month' ? summaryQuery.data?.currency : undefined}
          grouped={grouped}
          filtered={narrowed}
          allTime={mode.kind === 'all'}
          onLoadMore={() => txQuery.fetchNextPage()}
          onRetry={() => txQuery.refetch()}
          onRefresh={() => txQuery.refetch()}
          onEdit={openEdit}
          onAddFirst={openCreate}
          onClearFilters={clearSearchAndFilters}
        />
      </View>

      <TxFiltersSheet
        visible={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        categories={filterCategories}
        mode={mode}
        month={month}
        categoryId={categoryId}
        country={country}
        sort={sort}
        onModeChange={onModeChange}
        onCategoryChange={setCategoryId}
        onCountryChange={setCountry}
        onSortChange={setSort}
        onReset={() => {
          setCategoryId(null);
          setCountry(null);
          setSort(null);
          // The period unit is a filter too: "reset" from all-time or a custom
          // range lands back on the current month, as the web does.
          if (mode.kind !== 'month') setMode({ kind: 'month', month: currentMonth() });
        }}
      />
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
  rangeLabelButton: {
    minHeight: TOUCH_TARGET,
    justifyContent: 'center',
  },
  rangeLabel: {
    fontSize: 17,
    fontWeight: '600',
    color: colors.text,
  },
  rangeBack: {
    fontSize: 13,
    color: colors.primary,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingRight: spacing.lg,
  },
  searchWrap: {
    flex: 1,
  },
  filtersButton: {
    minHeight: TOUCH_TARGET,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    marginBottom: spacing.sm,
  },
  filtersActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primary,
  },
  filtersButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
  },
  filtersActiveText: {
    color: '#FFFFFF',
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
  listWrap: {
    flex: 1,
  },
  widgetWrap: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
  },
  // The card is full-bleed, as it was when it sat above the list; only the gap to
  // whatever follows it inside the header is new.
  summaryWrap: {
    marginBottom: spacing.md,
  },
});
