// Month summary card: income / expense / net totals + a per-category breakdown.
// All amounts render via formatMoney (W4) — net is signed and formatMoney renders
// the locale-correct minus; summary values are NEVER routed through toInputString.
// The breakdown joins against the archived-INCLUSIVE index so a since-archived
// category still resolves to its name (W3); the null bucket renders "Uncategorized";
// the composite key `${category_id ?? 'uncategorized'}:${kind}` handles the refund
// case that repeats a category_id under both kinds (W3).
import { formatMoney } from '@budget/shared';
import type { components } from '@budget/api-client';
import { StyleSheet, Text, View } from 'react-native';

import { FormButton } from '../../components/FormButton';
import { colors, spacing } from '../../components/theme';
import { APP_LOCALE } from '../../lib/locale';
import type { useSummary } from '../../data/transactions';

type CategoryRead = components['schemas']['CategoryRead'];
type CategorySummary = components['schemas']['CategorySummary'];

interface SummaryHeaderProps {
  summaryQuery: ReturnType<typeof useSummary>;
  categoryIndex: Map<string, CategoryRead>;
  onRetry: () => void;
}

function breakdownKey(row: CategorySummary): string {
  return `${row.category_id ?? 'uncategorized'}:${row.kind}`;
}

export function SummaryHeader({ summaryQuery, categoryIndex, onRetry }: SummaryHeaderProps) {
  if (summaryQuery.isPending) {
    return (
      <View style={styles.card}>
        <View style={styles.totals}>
          {['Income', 'Expense', 'Net'].map((label) => (
            <View key={label} style={styles.total}>
              <Text style={styles.totalLabel}>{label}</Text>
              <View style={styles.skeletonFigure} />
            </View>
          ))}
        </View>
      </View>
    );
  }

  if (summaryQuery.isError) {
    return (
      <View style={styles.card}>
        <Text accessibilityRole="alert" style={styles.error}>
          Couldn&apos;t load this month&apos;s summary.
        </Text>
        <FormButton label="Retry" variant="secondary" onPress={onRetry} />
      </View>
    );
  }

  const summary = summaryQuery.data;
  const { currency } = summary;
  const money = (minor: number) => formatMoney(minor, currency, { locale: APP_LOCALE });

  return (
    <View style={styles.card}>
      <View style={styles.totals}>
        <View style={styles.total}>
          <Text style={styles.totalLabel}>Income</Text>
          <Text style={[styles.totalValue, styles.income]}>{money(summary.income_minor)}</Text>
        </View>
        <View style={styles.total}>
          <Text style={styles.totalLabel}>Expense</Text>
          <Text style={[styles.totalValue, styles.expense]}>{money(summary.expense_minor)}</Text>
        </View>
        <View style={styles.total}>
          <Text style={styles.totalLabel}>Net</Text>
          <Text style={styles.totalValue}>{money(summary.net_minor)}</Text>
        </View>
      </View>

      {summary.by_category.length === 0 ? (
        <Text style={styles.emptyBreakdown}>No spend yet this month.</Text>
      ) : (
        <View style={styles.breakdown}>
          {summary.by_category.map((row) => {
            const category = row.category_id ? categoryIndex.get(row.category_id) : undefined;
            const name =
              row.category_id === null
                ? 'Uncategorized'
                : (category?.name ?? 'Unknown category');
            return (
              <View key={breakdownKey(row)} style={styles.breakdownRow}>
                <Text style={[styles.breakdownName, category?.archived && styles.archivedName]}>
                  {category?.icon ? `${category.icon} ` : ''}
                  {name}
                </Text>
                <Text style={styles.breakdownAmount}>{money(row.total_minor)}</Text>
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
  },
  totals: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  total: {
    flex: 1,
    gap: spacing.xs,
  },
  totalLabel: {
    fontSize: 12,
    color: colors.textMuted,
    textTransform: 'uppercase',
  },
  totalValue: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.text,
  },
  income: {
    color: colors.income,
  },
  expense: {
    color: colors.expense,
  },
  skeletonFigure: {
    height: 18,
    borderRadius: 4,
    backgroundColor: colors.border,
  },
  error: {
    color: colors.danger,
    fontSize: 14,
  },
  emptyBreakdown: {
    color: colors.textMuted,
    fontSize: 14,
  },
  breakdown: {
    gap: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.md,
  },
  breakdownRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  breakdownName: {
    color: colors.text,
    fontSize: 14,
    flexShrink: 1,
  },
  archivedName: {
    color: colors.textMuted,
    fontStyle: 'italic',
  },
  breakdownAmount: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '600',
    marginLeft: spacing.md,
  },
});
