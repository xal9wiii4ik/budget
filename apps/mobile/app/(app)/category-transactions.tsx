// One category's operations (catch-up 3, line A) — web's `CategoryTransactionsModal`
// as a PUSHED SCREEN.
//
// Web opens a window over /categories because a modal there is cheap and the list
// underneath stays visible. On a phone a window over a full-screen list IS a screen,
// and pushing it gets the platform's own way out for free (iOS swipe-back, Android
// back). It is deliberately NOT `presentation: 'modal'`: the form screens are modals
// because they interrupt to collect an answer; this one is a place you navigate to
// and read.
//
// The headline is `/stats/summary`'s own `total_minor` for this category, picked by
// id AND kind (`categoryPeriodTotal`) — the client sums nothing. That is also why the
// period has no all-time mode: the stats period grammar has no all-time unit, and a
// list with no total to head it would leave exactly the question this screen exists
// to answer unanswered.
//
// The rows come from the SAME query (same key, same page size) the transactions tab
// builds for this category and period (`categoryListFilters`), so opening this screen
// after filtering the tab — or the other way round — reuses one cache entry.
import {
  currentMonth,
  formatApiDate,
  formatMonthLabel,
  formatMoney,
  monthBounds,
  toApiDate,
} from '@budget/shared';
import type { components } from '@budget/api-client';
import DateTimePicker, {
  type DateTimePickerChangeEvent,
} from '@react-native-community/datetimepicker';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FormButton } from '../../src/components/FormButton';
import { colors, spacing, TOUCH_TARGET } from '../../src/components/theme';
import { useCategories } from '../../src/data/categories';
import type { AccountRead } from '../../src/data/accounts';
import { buildCategoryIndex } from '../../src/data/categoryLookup';
import { useStatsSummary } from '../../src/data/stats';
import { useTransactions } from '../../src/data/transactions';
import {
  categoryPeriodTotal,
  categoryStatsPeriod,
  type CategoryPeriod,
} from '../../src/features/categories/categoryDrilldown';
import { MonthPicker } from '../../src/features/transactions/MonthPicker';
import { TransactionList } from '../../src/features/transactions/TransactionList';
import {
  categoryListFilters,
  customRange,
  isValidRangeDate,
  TX_LIST_LIMIT,
} from '../../src/features/transactions/txFilters';
import { useLocale, useT } from '../../src/i18n/context';

type TransactionRead = components['schemas']['TransactionRead'];

// A transfer has NO category (its category_id is null by design), so a
// category-filtered list can never contain one and the transfer arm's name lookup is
// unreachable here. Module-level so the identity is stable across renders.
const NO_ACCOUNTS: Map<string, AccountRead> = new Map();

/**
 * The route's own parameter check, kept OUTSIDE the screen body so that a call with
 * no id never issues a request for `category_id: ''` — a 422 whose error state is
 * behind an early return nobody would ever see.
 */
export default function CategoryTransactionsScreen() {
  const params = useLocalSearchParams<{ id?: string }>();
  return params.id === undefined ? (
    <Unavailable />
  ) : (
    <CategoryTransactions categoryId={params.id} />
  );
}

function CategoryTransactions({ categoryId }: { categoryId: string }) {
  const t = useT();
  const locale = useLocale();

  // Period is LOCAL state, seeded from the current month — the screen is
  // deep-link-safe (it depends on nothing the previous screen held except the id in
  // its own URL).
  const [period, setPeriod] = useState<CategoryPeriod>(() => ({
    kind: 'month',
    month: currentMonth(),
  }));
  const [month, setMonth] = useState(() => currentMonth());
  const [composingRange, setComposingRange] = useState(false);

  // The category comes out of the ONE archived-inclusive cache entry, which is also
  // what the tab reads — so arriving here needs no request of its own, and an
  // archived category still resolves to its name.
  const categoriesQuery = useCategories();
  const categoryIndex = useMemo(
    () => buildCategoryIndex(categoriesQuery.data ?? []),
    [categoriesQuery.data],
  );
  const category = categoryIndex.get(categoryId);

  const summaryQuery = useStatsSummary(categoryStatsPeriod(period));
  const txQuery = useTransactions(categoryListFilters(categoryId, period, TX_LIST_LIMIT));

  const transactions = txQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const total = txQuery.data?.pages[0]?.total ?? 0;
  const periodLabel =
    period.kind === 'custom'
      ? t('tx.rangeLabel', {
          from: formatApiDate(period.from, { locale }),
          to: formatApiDate(period.to, { locale }),
        })
      : formatMonthLabel(period.month, { locale });

  // Tapping a row opens the edit form with the ROW'S month — the form locates its
  // target inside the cached unfiltered month list, and this screen's period may be a
  // custom window spanning several months (or none of the row's). See the same rule
  // and reason on the transactions tab.
  const openEdit = (transaction: TransactionRead) =>
    router.push({
      pathname: transaction.kind === 'transfer' ? '/transfer-form' : '/transaction-form',
      params: { month: transaction.occurred_at.slice(0, 7), id: transaction.id },
    });

  // A cold deep link (or a re-login) whose id the LOADED list does not know: the
  // header cannot be titled and the total cannot be attributed to a kind, so the
  // screen says so rather than showing a list under someone else's name. Only once
  // the list has actually loaded — while it is pending this is simply "not yet".
  if (categoriesQuery.data !== undefined && category === undefined) return <Unavailable />;

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      {/* The header title is the category's own NAME — user text, never translated.
          While the cache is still loading it falls back to the tab's name rather than
          to an empty bar. */}
      <Stack.Screen
        options={{ headerShown: true, title: category?.name ?? t('tabs.categories') }}
      />

      <View style={styles.periodRow}>
        {period.kind === 'month' && !composingRange ? (
          <View style={styles.monthWrap}>
            <MonthPicker
              month={month}
              onChange={(next) => {
                setMonth(next);
                setPeriod({ kind: 'month', month: next });
              }}
            />
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('tx.rangeBackToMonth')}
            onPress={() => {
              setComposingRange(false);
              setPeriod({ kind: 'month', month });
            }}
            style={styles.rangeLabelButton}
          >
            <Text style={styles.rangeLabel} numberOfLines={1}>
              {periodLabel}
            </Text>
            <Text style={styles.rangeBack}>{t('tx.rangeBackToMonth')}</Text>
          </Pressable>
        )}
        {composingRange ? null : (
          <Pressable
            accessibilityRole="button"
            onPress={() => setComposingRange(true)}
            style={styles.rangeButton}
          >
            <Text style={styles.rangeButtonText}>{t('tx.rangeCustom')}</Text>
          </Pressable>
        )}
      </View>

      {composingRange ? (
        <CustomRange
          applied={period.kind === 'custom' ? period : null}
          month={month}
          onApply={(range) => {
            setComposingRange(false);
            setPeriod({ kind: 'custom', ...range });
          }}
          onCancel={() => setComposingRange(false)}
        />
      ) : null}

      {/* The headline: a SERVER total, in the response's OWN currency (the profile
          base) — never a currency taken from somewhere else on the screen. */}
      <View style={styles.headline}>
        <Text style={styles.headlineLabel}>{t('categoryTx.total')}</Text>
        {summaryQuery.isPending ? (
          <View style={styles.headlineSkeleton} />
        ) : summaryQuery.isError ? (
          <>
            <Text accessibilityRole="alert" style={styles.error}>
              {t('categoryTx.totalFailed')}
            </Text>
            <FormButton
              label={t('common.retry')}
              variant="secondary"
              onPress={() => summaryQuery.refetch()}
            />
          </>
        ) : category === undefined ? (
          // The total is picked by id AND KIND, and the kind is the category's own —
          // guessing it would show a refund's income bucket as this category's spend.
          // So the figure waits for the category rather than being approximated.
          <View style={styles.headlineSkeleton} />
        ) : (
          <>
            <Text style={styles.headlineValue}>
              {formatMoney(
                categoryPeriodTotal(summaryQuery.data, categoryId, category.kind),
                summaryQuery.data.currency,
                { locale },
              )}
            </Text>
            {/* Rate-less rows are EXCLUDED from the server's totals; that exclusion is
                disclosed rather than silently absorbed. */}
            {summaryQuery.data.unconverted_count > 0 ? (
              <Text style={styles.unconverted}>
                {t('unconverted.totals', { count: summaryQuery.data.unconverted_count })}
              </Text>
            ) : null}
          </>
        )}
      </View>

      <View style={styles.listWrap}>
        <TransactionList
          transactions={transactions}
          total={total}
          status={txQuery.status}
          hasMore={txQuery.hasNextPage}
          isLoadingMore={txQuery.isFetchingNextPage}
          isRefreshing={txQuery.isRefetching && !txQuery.isFetchingNextPage}
          periodLabel={periodLabel}
          // Every row in this list is in THIS category (the server filtered them), so
          // the one entry is the whole join.
          categoryIndex={categoryIndex}
          accountsById={NO_ACCOUNTS}
          viewAccountId={undefined}
          // = the profile base currency, from the response that already has to be on
          // screen for the total above.
          summaryCurrency={summaryQuery.data?.currency}
          grouped
          // The list IS one category — the empty state must say "nothing in this
          // period", not offer to clear a filter this screen does not own.
          filtered={false}
          allTime={false}
          emptyMessage={t('categoryTx.empty')}
          onLoadMore={() => txQuery.fetchNextPage()}
          onRetry={() => txQuery.refetch()}
          onRefresh={() => txQuery.refetch()}
          onEdit={openEdit}
          // No `onAddFirst`: a new row would have to land in this category AND this
          // period, which the form cannot promise, so the offer would be a lie.
        />
      </View>
    </SafeAreaView>
  );
}

/** The route pointed at a category this session cannot name. One way out: back. */
function Unavailable() {
  const t = useT();

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <Stack.Screen options={{ headerShown: true, title: t('tabs.categories') }} />
      <View style={styles.stateBox}>
        <Text accessibilityRole="alert" style={styles.error}>
          {t('categoryTx.unavailable')}
        </Text>
        <FormButton label={t('common.goBack')} variant="secondary" onPress={() => router.back()} />
      </View>
    </SafeAreaView>
  );
}

// "YYYY-MM-DD" -> a LOCAL Date (component build, no UTC parse — TZ-safe like the
// shared date helpers), for feeding the native picker.
function apiDateToLocalDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * The two-date form. The draft is local until it is APPLIED: an incomplete or
 * inverted pair never becomes a query key, so the list keeps the window it has and
 * the message sits under the fields that are wrong.
 */
function CustomRange({
  applied,
  month,
  onApply,
  onCancel,
}: {
  applied: { from: string; to: string } | null;
  month: string;
  onApply: (range: { from: string; to: string }) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [draft, setDraft] = useState(() => applied ?? monthBounds(month));
  const [submitted, setSubmitted] = useState(false);
  const [editing, setEditing] = useState<'from' | 'to' | null>(null);

  const valid = customRange(draft.from, draft.to);
  const incomplete = !isValidRangeDate(draft.from) || !isValidRangeDate(draft.to);
  const error =
    !submitted || valid !== null ? null : t(incomplete ? 'tx.rangeIncomplete' : 'tx.rangeInverted');

  // F-3 (the forms' rule): `onChange` is deprecated in
  // @react-native-community/datetimepicker 9.x; onValueChange/onDismiss are the two
  // branches. Android closes the dialog either way, iOS keeps the inline picker up.
  const onPicked = (edge: 'from' | 'to') => (_event: DateTimePickerChangeEvent, date: Date) => {
    if (Platform.OS !== 'ios') setEditing(null);
    setSubmitted(false);
    // LOCAL-time, never toISOString (which shifts the day for half the planet).
    setDraft((previous) => ({ ...previous, [edge]: toApiDate(date) }));
  };

  return (
    <View style={styles.customRange}>
      {(['from', 'to'] as const).map((edge) => (
        <View key={edge} style={styles.dateField}>
          <Text style={styles.dateLabel}>{t(edge === 'from' ? 'period.from' : 'period.to')}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t(edge === 'from' ? 'period.from' : 'period.to')}
            onPress={() => setEditing(edge)}
            style={styles.dateButton}
          >
            <Text style={styles.dateText}>{formatApiDate(draft[edge], { locale })}</Text>
          </Pressable>
          {editing === edge ? (
            <>
              <DateTimePicker
                value={apiDateToLocalDate(draft[edge])}
                mode="date"
                display={Platform.OS === 'ios' ? 'inline' : 'default'}
                onValueChange={onPicked(edge)}
                onDismiss={() => setEditing(null)}
              />
              {Platform.OS === 'ios' ? (
                <FormButton
                  label={t('common.done')}
                  variant="secondary"
                  onPress={() => setEditing(null)}
                />
              ) : null}
            </>
          ) : null}
        </View>
      ))}
      {error === null ? null : (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      <FormButton
        label={t('tx.rangeApply')}
        onPress={() => {
          setSubmitted(true);
          if (valid !== null) onApply(valid);
        }}
      />
      <FormButton label={t('common.cancel')} variant="secondary" onPress={onCancel} />
    </View>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  periodRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  monthWrap: {
    flex: 1,
  },
  rangeLabelButton: {
    flex: 1,
    minHeight: TOUCH_TARGET,
    justifyContent: 'center',
  },
  rangeLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
  },
  rangeBack: {
    fontSize: 13,
    color: colors.primary,
  },
  rangeButton: {
    minHeight: TOUCH_TARGET,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  rangeButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.primary,
  },
  customRange: {
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  dateField: {
    gap: spacing.xs,
  },
  dateLabel: {
    fontSize: 13,
    color: colors.textMuted,
  },
  dateButton: {
    minHeight: TOUCH_TARGET,
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.card,
  },
  dateText: {
    fontSize: 16,
    color: colors.text,
  },
  headline: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    padding: spacing.lg,
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.xs,
  },
  headlineLabel: {
    fontSize: 12,
    color: colors.textMuted,
    textTransform: 'uppercase',
  },
  headlineValue: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.text,
  },
  headlineSkeleton: {
    height: 26,
    borderRadius: 4,
    backgroundColor: colors.border,
  },
  unconverted: {
    fontSize: 12,
    color: colors.textMuted,
  },
  stateBox: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  error: {
    color: colors.danger,
    fontSize: 14,
  },
  listWrap: {
    flex: 1,
  },
});
