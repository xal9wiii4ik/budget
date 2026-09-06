// Transaction list. Long-list rule (agent): a SectionList (never .map in a
// ScrollView), day-grouped via groupByDay (preserves the server's occurred_at order,
// no re-sort), keyExtractor by id, memoized rows. onEndReached drives load-more; the
// footer shows "Showing N of total". Handles loading / empty / error / success.
//
// catch-up 3 line A, three additions, all driven by the new filters:
//   * `grouped` — under an amount sort the day headers go away (`showsDayGroups`):
//     the groups would each hold one or two rows in no date order, which reads as
//     broken rather than as grouped. The list becomes ONE section and every row
//     prints its own date instead. Still a SectionList, not a second component —
//     the footer, the paging and the four states are the same list's.
//   * `periodLabel` (was `monthLabel`) and the `filtered` / `allTime` pair — the
//     empty state has to say WHY it is empty. "No transactions in August" is a lie
//     about a three-day custom window, and it is the wrong advice when the reason is
//     a search that matches nothing.
//   * `summaryCurrency` — threaded to the rows for the "≈ base" line; `undefined`
//     whenever the summary is not on screen (see TransactionRow).
//
// `header` (catch-up 3 wiring) is whatever the screen wants ABOVE the rows — the
// transactions tab's two widgets. It rides inside the list (ListHeaderComponent) so
// it scrolls away instead of pinning two cards over the viewport, and it is repeated
// above the pending / error / empty arms, which render outside the SectionList: a
// widget that vanished while the list loaded would be the worse behaviour.
import { formatApiDate, sentenceEnd } from '@budget/shared';
import type { components } from '@budget/api-client';
import { useMemo, type ReactNode } from 'react';
import { ActivityIndicator, ScrollView, SectionList, StyleSheet, Text, View } from 'react-native';

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
  /** The window in words: a month label, or "1 Aug – 15 Aug" for a custom period. */
  periodLabel: string;
  categoryIndex: Map<string, CategoryRead>;
  // accounts-and-transfers MOB: passed straight to the rows — the transfer arm
  // joins the two account NAMES, and `viewAccountId` (the active account filter)
  // decides which leg of a transfer this list is showing.
  accountsById: Map<string, AccountRead>;
  viewAccountId: string | undefined;
  /** The profile base currency, or undefined when no summary is on screen. */
  summaryCurrency: string | undefined;
  /** Day headers on (date orders) or off (amount orders) — `showsDayGroups`. */
  grouped: boolean;
  /** Whether anything is holding rows back (`isNarrowed`) — the empty state's why. */
  filtered: boolean;
  /** All-time mode: there is no period to name in the empty state. */
  allTime: boolean;
  /**
   * Overrides the empty sentence. The category screen says something the four arms
   * below cannot: its list is not "August" or "these filters", it is ONE category
   * over a period, and the way out is a different period rather than a cleared
   * filter (web's `TxWindowModal` carries the same override for the same reason).
   */
  emptyMessage?: string;
  onLoadMore: () => void;
  onRetry: () => void;
  onRefresh: () => void;
  onEdit: (transaction: TransactionRead) => void;
  /**
   * Offered in the "nothing here yet" arm only. OPTIONAL: the category screen shows
   * the same list, and "add the first one" is not an answer there — the row would
   * have to land in that category and that period, which the form cannot promise.
   */
  onAddFirst?: () => void;
  /** Offered in the "nothing matches" arm, when the caller can undo the filters. */
  onClearFilters?: () => void;
  /** Rendered above the rows AND above every non-success arm (see the file head). */
  header?: ReactNode;
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
  periodLabel,
  categoryIndex,
  accountsById,
  viewAccountId,
  summaryCurrency,
  grouped,
  filtered,
  allTime,
  emptyMessage,
  onLoadMore,
  onRetry,
  onRefresh,
  onEdit,
  onAddFirst,
  onClearFilters,
  header,
}: TransactionListProps) {
  const t = useT();
  const locale = useLocale();

  const sections = useMemo<DaySection[]>(
    () =>
      grouped
        ? groupByDay(transactions).map((group) => ({ date: group.date, data: group.items }))
        : // One section, no header. The server's order is preserved exactly as in the
          // grouped case — nothing here re-sorts anything.
          [{ date: '', data: transactions }],
    [transactions, grouped],
  );

  if (status === 'pending') {
    return (
      <StateShell header={header}>
        {[0, 1, 2, 3].map((i) => (
          <View key={i} style={styles.skeletonRow} />
        ))}
      </StateShell>
    );
  }

  if (status === 'error') {
    return (
      <StateShell header={header}>
        <Text accessibilityRole="alert" style={styles.error}>
          {t('tx.loadFailed')}
        </Text>
        <FormButton label={t('common.retry')} variant="secondary" onPress={onRetry} />
      </StateShell>
    );
  }

  if (transactions.length === 0) {
    return (
      <StateShell header={header}>
        {emptyMessage === undefined ? (
          <EmptyMessage
            filtered={filtered}
            allTime={allTime}
            periodLabel={periodLabel}
            hasAdd={onAddFirst !== undefined}
          />
        ) : (
          <Text style={styles.emptyText}>{emptyMessage}</Text>
        )}
        {/* The way OUT of the state, and only the one that applies: clearing filters
            when filters are why, adding a transaction when emptiness is why. */}
        {filtered && onClearFilters !== undefined ? (
          <FormButton
            label={t('tx.emptyClearFilters')}
            variant="secondary"
            onPress={onClearFilters}
          />
        ) : null}
        {!filtered && onAddFirst !== undefined ? (
          <FormButton label={t('tx.add')} onPress={onAddFirst} />
        ) : null}
      </StateShell>
    );
  }

  return (
    <SectionList
      sections={sections}
      keyExtractor={(item) => item.id}
      // A ReactNode is not a ReactElement, so it is wrapped rather than cast; an
      // absent header stays absent instead of becoming an empty fragment.
      ListHeaderComponent={header === undefined ? undefined : <>{header}</>}
      stickySectionHeadersEnabled={false}
      onRefresh={onRefresh}
      refreshing={isRefreshing}
      onEndReachedThreshold={0.4}
      onEndReached={() => {
        if (hasMore && !isLoadingMore) onLoadMore();
      }}
      renderSectionHeader={
        grouped
          ? ({ section }) => (
              <Text style={styles.dayLabel}>
                {formatApiDate((section as DaySection).date, { locale })}
              </Text>
            )
          : undefined
      }
      renderItem={({ item }) => (
        <TransactionRow
          transaction={item}
          category={item.category_id ? categoryIndex.get(item.category_id) : undefined}
          accountsById={accountsById}
          viewAccountId={viewAccountId}
          summaryCurrency={summaryCurrency}
          showDate={!grouped}
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

/**
 * The frame every non-success arm shares: the caller's header, then the state box.
 * A ScrollView, because the header can be two widget cards and a small screen would
 * otherwise cut the skeletons, the retry button or the "add the first one" off the
 * bottom with no way to reach them. Nothing unbounded is rendered inside it — the
 * rows live in the SectionList.
 */
function StateShell({ header, children }: { header: ReactNode; children: ReactNode }) {
  return (
    <ScrollView contentContainerStyle={styles.stateContent}>
      {header}
      <View style={styles.stateBox}>{children}</View>
    </ScrollView>
  );
}

/**
 * Why the list is empty, said out loud. Four arms, in the order of how actionable
 * they are: filters that match nothing (with and without a period to name), a period
 * with nothing in it, and an account that has no history at all.
 */
function EmptyMessage({
  filtered,
  allTime,
  periodLabel,
  hasAdd,
}: {
  filtered: boolean;
  allTime: boolean;
  periodLabel: string;
  hasAdd: boolean;
}) {
  const t = useT();

  if (filtered) {
    return (
      <Text style={styles.emptyText}>
        {allTime
          ? t('tx.emptyFiltered')
          : sentenceEnd(t('tx.emptyFilteredMonth', { month: periodLabel }))}
      </Text>
    );
  }
  if (allTime) {
    return <Text style={styles.emptyText}>{t('tx.emptyAll')}</Text>;
  }
  return (
    <Text style={styles.emptyText}>
      {/* F-4: ru month labels already end in '.' ("август 2026 г.") — sentenceEnd
          terminates the sentence without doubling the period. */}
      {sentenceEnd(t('tx.emptyMonth', { month: periodLabel }))}
      {hasAdd ? ` ${t('tx.emptyMonthCta')}` : ''}
    </Text>
  );
}

const styles = StyleSheet.create({
  stateContent: {
    paddingBottom: spacing.xl,
  },
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
