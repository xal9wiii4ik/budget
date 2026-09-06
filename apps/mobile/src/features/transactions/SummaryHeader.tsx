// Month summary card: income / expense / net totals + a per-category breakdown.
// All amounts render via formatMoney (W4) — net is signed and formatMoney renders
// the locale-correct minus; summary values are NEVER routed through toInputString.
// The breakdown joins against the archived-INCLUSIVE index so a since-archived
// category still resolves to its name (W3); the null bucket renders "Uncategorized";
// the composite key `${category_id ?? 'uncategorized'}:${kind}` handles the refund
// case that repeats a category_id under both kinds (W3).
import { formatMoney } from '@budget/shared';
import type { components } from '@budget/api-client';
import { Text, View } from 'react-native';

import { Card } from '../../components/Card';
import { FormButton } from '../../components/FormButton';
import { themedStyles } from '../../theme/themedStyles';
import { useLocale, useT } from '../../i18n/context';
import type { SimpleKey } from '../../i18n/t';
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

const TOTAL_LABEL_KEYS: readonly SimpleKey[] = [
  'common.income',
  'common.expense',
  'common.net',
];

export function SummaryHeader({ summaryQuery, categoryIndex, onRetry }: SummaryHeaderProps) {
  const t = useT();
  const styles = useStyles();
  const locale = useLocale();

  if (summaryQuery.isPending) {
    return (
      <Card style={styles.card}>
        <View style={styles.totals}>
          {TOTAL_LABEL_KEYS.map((key) => (
            <View key={key} style={styles.total}>
              <Text style={styles.totalLabel}>{t(key)}</Text>
              <View style={styles.skeletonFigure} />
            </View>
          ))}
        </View>
      </Card>
    );
  }

  if (summaryQuery.isError) {
    return (
      <Card style={styles.card}>
        <Text accessibilityRole="alert" style={styles.error}>
          {t('summary.loadFailed')}
        </Text>
        <FormButton label={t('common.retry')} variant="secondary" onPress={onRetry} />
      </Card>
    );
  }

  const summary = summaryQuery.data;
  const { currency } = summary;
  const money = (minor: number) => formatMoney(minor, currency, { locale });

  return (
    <Card style={styles.card}>
      <View style={styles.totals}>
        <View style={styles.total}>
          <Text style={styles.totalLabel}>{t('common.income')}</Text>
          <Text style={[styles.totalValue, styles.income]}>{money(summary.income_minor)}</Text>
        </View>
        <View style={styles.total}>
          <Text style={styles.totalLabel}>{t('common.expense')}</Text>
          <Text style={[styles.totalValue, styles.expense]}>{money(summary.expense_minor)}</Text>
        </View>
        <View style={styles.total}>
          <Text style={styles.totalLabel}>{t('common.net')}</Text>
          <Text style={styles.totalValue}>{money(summary.net_minor)}</Text>
        </View>
      </View>

      {summary.unconverted_count > 0 ? (
        // D9 (web's SummaryHeader, same sentence): rows with no exchange rate are
        // EXCLUDED from the server's totals, and that exclusion is DISCLOSED —
        // otherwise an incomplete month reads as a complete one. Not an error: the
        // month is still usable, it is just missing those rows.
        <Text style={styles.unconverted}>
          {t('unconverted.totals', { count: summary.unconverted_count })}
        </Text>
      ) : null}

      {summary.by_category.length === 0 ? (
        <Text style={styles.emptyBreakdown}>{t('summary.noSpend')}</Text>
      ) : (
        <View style={styles.breakdown}>
          {summary.by_category.map((row) => {
            const category = row.category_id ? categoryIndex.get(row.category_id) : undefined;
            // The category NAME is the user's own text; only the two fallbacks
            // are copy.
            const name =
              row.category_id === null
                ? t('common.uncategorized')
                : (category?.name ?? t('common.unknownCategory'));
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
    </Card>
  );
}

const useStyles = themedStyles((t) => ({
  // The BOX is the shared Card (surface + border + radius); what stays here is
  // only the inner rhythm. No `flex` of any kind: this card rides inside the
  // list's header, and a flexing sibling above a list squeezes it to zero.
  card: {
    gap: t.spacing.md,
  },
  totals: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  total: {
    flex: 1,
    gap: t.spacing.xs,
  },
  totalLabel: {
    fontSize: t.type.xs,
    color: t.colors.textMuted,
    textTransform: 'uppercase',
  },
  totalValue: {
    fontSize: t.type.md,
    fontWeight: '700',
    color: t.colors.text,
    ...t.tnum,
  },
  income: {
    color: t.colors.income,
  },
  expense: {
    color: t.colors.expense,
  },
  skeletonFigure: {
    height: 18,
    borderRadius: t.radius.sm,
    backgroundColor: t.colors.surfaceMuted,
  },
  error: {
    color: t.colors.danger,
    fontSize: t.type.sm,
  },
  // A degradation notice, not an expense: the WARNING tone, never the money red
  // (the same box web draws for the same sentence).
  unconverted: {
    backgroundColor: t.colors.warningSoft,
    color: t.colors.warningSoftFg,
    borderRadius: t.radius.md,
    paddingHorizontal: t.spacing.md,
    paddingVertical: t.spacing.sm,
    fontSize: t.type.sm,
  },
  emptyBreakdown: {
    color: t.colors.textMuted,
    fontSize: t.type.sm,
  },
  breakdown: {
    gap: t.spacing.sm,
    borderTopWidth: 1,
    borderTopColor: t.colors.border,
    paddingTop: t.spacing.md,
  },
  breakdownRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  breakdownName: {
    color: t.colors.text,
    fontSize: t.type.sm,
    flexShrink: 1,
  },
  archivedName: {
    color: t.colors.textMuted,
    fontStyle: 'italic',
  },
  breakdownAmount: {
    color: t.colors.text,
    fontSize: t.type.sm,
    fontWeight: '600',
    marginLeft: t.spacing.md,
    ...t.tnum,
  },
}));
