// One transaction row (memoized for FlatList/SectionList perf). The stored
// amount_minor is a magnitude (>=1); the SIGN is carried by kind (W4/W5) — expense
// renders negative/red, income positive/green via formatMoney(signedMinor,...). No
// float math. The category name/icon is joined from the archived-inclusive index; a
// null category renders "Uncategorized" (W3). Currency is the row's own (W7).
// accounts-and-transfers MOB: a transfer row is delegated to TransferRow.
import { formatMoney } from '@budget/shared';
import type { components } from '@budget/api-client';
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, spacing, TOUCH_TARGET } from '../../components/theme';
import type { AccountRead } from '../../data/accounts';
import { APP_LOCALE } from '../../lib/locale';
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
  onEdit: (transaction: TransactionRead) => void;
}

function TransactionRowImpl({
  transaction,
  category,
  accountsById,
  viewAccountId,
  onEdit,
}: TransactionRowProps) {
  // A transfer is ONE row showing BOTH sides (A1) — it has no category and no
  // base equivalent, so it takes its own component instead of threading nulls
  // through this one.
  if (transaction.kind === 'transfer') {
    return (
      <TransferRow
        transaction={transaction}
        accountsById={accountsById}
        viewAccountId={viewAccountId}
        onEdit={onEdit}
      />
    );
  }

  const isExpense = transaction.kind === 'expense';
  const signedMinor = isExpense ? -transaction.amount_minor : transaction.amount_minor;
  const name =
    transaction.category_id === null ? 'Uncategorized' : (category?.name ?? 'Unknown category');

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
      </View>
      <Text style={[styles.amount, isExpense ? styles.expense : styles.income]}>
        {formatMoney(signedMinor, transaction.currency, { locale: APP_LOCALE })}
      </Text>
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
  amount: {
    fontSize: 15,
    fontWeight: '600',
  },
  income: {
    color: colors.income,
  },
  expense: {
    color: colors.expense,
  },
});

export const TransactionRow = memo(TransactionRowImpl);
