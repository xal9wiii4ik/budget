// One transaction row (memoized for FlatList/SectionList perf). The stored
// amount_minor is a magnitude (>=1); the SIGN is carried by kind (W4/W5) — expense
// renders negative/red, income positive/green via formatMoney(signedMinor,...). No
// float math. The category name/icon is joined from the archived-inclusive index; a
// null category renders "Uncategorized" (W3). Currency is the row's own (W7).
// accounts-and-transfers MOB: a transfer row is delegated to TransferRow.
//
// catch-up 3 line A (follow-up N-2): the row shows AT MOST TWO money lines, chosen
// by `primaryAmount` (@budget/api-client — the module web has always used, moved
// there in this scope so both clients answer "which amount leads" identically). A
// foreign purchase leads with what was SPENT — the number the user remembers, "€50
// at the bakery" — over what the account was actually CHARGED; everything else shows
// its own amount over the "≈ base" snapshot. The second line is not garnish: it is
// the only thing that explains why the month's total is not the sum of the column
// above it, which is why it is plain text and never behind a tap.
import { formatApiDate, formatMoney } from '@budget/shared';
import { primaryAmount } from '@budget/api-client';
import type { components } from '@budget/api-client';
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, spacing, TOUCH_TARGET } from '../../components/theme';
import type { AccountRead } from '../../data/accounts';
import { useLocale, useT } from '../../i18n/context';
import { TransferRow } from './TransferRow';

type CategoryRead = components['schemas']['CategoryRead'];
type TransactionRead = components['schemas']['TransactionRead'];

interface TransactionRowProps {
  transaction: TransactionRead;
  category: CategoryRead | undefined;
  // accounts-and-transfers MOB: only the transfer arm reads these, and only for
  // NAMES — both amounts and both currencies come from the row itself.
  accountsById: Map<string, AccountRead>;
  /** The account the list is filtered by, or undefined for the all-accounts list. */
  viewAccountId: string | undefined;
  /**
   * The month summary's currency = the profile base currency. `undefined` whenever
   * the summary is not on screen (all-time and custom-period modes) or is still
   * loading: a base equivalent cannot be judged stale without knowing the base, so
   * the row then shows its own amount only.
   */
  summaryCurrency: string | undefined;
  /**
   * Under an amount sort the list drops its day headers (`showsDayGroups`), so the
   * row itself has to state its date. False in the grouped layout, where the header
   * already does.
   */
  showDate: boolean;
  onEdit: (transaction: TransactionRead) => void;
}

function TransactionRowImpl({
  transaction,
  category,
  accountsById,
  viewAccountId,
  summaryCurrency,
  showDate,
  onEdit,
}: TransactionRowProps) {
  const t = useT();
  const locale = useLocale();

  // A transfer is ONE row showing BOTH sides (A1) — it has no category and no
  // base equivalent, so it takes its own component instead of threading nulls
  // through this one.
  if (transaction.kind === 'transfer') {
    return (
      <TransferRow
        transaction={transaction}
        accountsById={accountsById}
        viewAccountId={viewAccountId}
        showDate={showDate}
        onEdit={onEdit}
      />
    );
  }

  const isExpense = transaction.kind === 'expense';
  // The magnitude is the row's; the SIGN comes from `kind`, applied to whichever
  // amount each line carries.
  const amounts = primaryAmount(transaction, summaryCurrency);
  const sign = (minor: number) => (isExpense ? -minor : minor);
  // The category NAME is the user's own text; only the two fallbacks are copy.
  const name =
    transaction.category_id === null
      ? t('common.uncategorized')
      : (category?.name ?? t('common.unknownCategory'));

  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => onEdit(transaction)}
      style={styles.row}
    >
      <Text style={styles.icon}>{category?.icon ?? '•'}</Text>
      <View style={styles.details}>
        <Text style={styles.categoryName} numberOfLines={1}>
          {name}
        </Text>
        {transaction.note ? (
          <Text style={styles.note} numberOfLines={1}>
            {transaction.note}
          </Text>
        ) : null}
        {showDate ? (
          <Text style={styles.note}>{formatApiDate(transaction.occurred_at, { locale })}</Text>
        ) : null}
      </View>
      <View style={styles.amountCell}>
        <Text style={[styles.amount, isExpense ? styles.expense : styles.income]}>
          {formatMoney(sign(amounts.primary.minor), amounts.primary.currency, { locale })}
        </Text>
        {amounts.secondary ? (
          <Text style={styles.secondaryAmount}>
            {amounts.secondary.kind === 'base' ? '≈ ' : ''}
            {formatMoney(sign(amounts.secondary.minor), amounts.secondary.currency, { locale })}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.card,
    gap: spacing.md,
  },
  icon: {
    fontSize: 20,
    width: 24,
    textAlign: 'center',
  },
  details: {
    flex: 1,
    gap: 2,
  },
  categoryName: {
    fontSize: 15,
    color: colors.text,
    fontWeight: '500',
  },
  note: {
    fontSize: 13,
    color: colors.textMuted,
  },
  amountCell: {
    alignItems: 'flex-end',
    gap: 2,
  },
  amount: {
    fontSize: 15,
    fontWeight: '600',
  },
  secondaryAmount: {
    fontSize: 12,
    color: colors.textMuted,
  },
  income: {
    color: colors.income,
  },
  expense: {
    color: colors.expense,
  },
});

export const TransactionRow = memo(TransactionRowImpl);
