// One account row (memoized for the virtualized list).
//
// `balance_minor` is COMPUTED BY THE SERVER (architecture §2) and rendered with
// the account's OWN currency — nothing here adds a starting balance to a sum of
// transactions, and nothing converts between currencies. A negative balance (a
// card in the minus is legitimate) goes through the shared formatter, so its sign
// follows the user's locale instead of a hand-glued "-".
import { formatMoney } from '@budget/shared';
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, spacing, TOUCH_TARGET } from '../../components/theme';
import type { AccountRead } from '../../data/accounts';
import { APP_LOCALE } from '../../lib/locale';

interface AccountRowProps {
  account: AccountRead;
  onEdit: (account: AccountRead) => void;
}

const TYPE_LABEL: Record<AccountRead['type'], string> = {
  card: 'Card',
  cash: 'Cash',
};

function AccountRowImpl({ account, onEdit }: AccountRowProps) {
  return (
    <Pressable accessibilityRole="button" onPress={() => onEdit(account)} style={styles.row}>
      <Text style={styles.icon}>{account.type === 'cash' ? '💵' : '💳'}</Text>
      <View style={styles.details}>
        <Text
          style={[styles.name, account.archived && styles.archivedName]}
          numberOfLines={1}
        >
          {account.name}
        </Text>
        <Text style={styles.meta}>
          {TYPE_LABEL[account.type]} · {account.currency}
          {account.archived ? ' · Archived' : ''}
        </Text>
      </View>
      <Text style={[styles.balance, account.balance_minor < 0 && styles.negative]}>
        {formatMoney(account.balance_minor, account.currency, { locale: APP_LOCALE })}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.card,
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
  name: {
    fontSize: 15,
    fontWeight: '500',
    color: colors.text,
  },
  archivedName: {
    color: colors.textMuted,
    fontStyle: 'italic',
  },
  meta: {
    fontSize: 13,
    color: colors.textMuted,
  },
  balance: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text,
  },
  negative: {
    color: colors.expense,
  },
});

export const AccountRow = memo(AccountRowImpl);
