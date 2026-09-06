// One account row (memoized for the virtualized list).
//
// `balance_minor` is COMPUTED BY THE SERVER (architecture §2) and rendered with
// the account's OWN currency — nothing here adds a starting balance to a sum of
// transactions, and nothing converts between currencies. A negative balance (a
// card in the minus is legitimate) goes through the shared formatter, so its sign
// follows the user's locale instead of a hand-glued "-".
import { formatMoney } from '@budget/shared';
import { memo } from 'react';
import { Pressable, Text, View } from 'react-native';

import { themedStyles } from '../../theme/themedStyles';
import type { AccountRead } from '../../data/accounts';
import { useLocale, useT } from '../../i18n/context';
import type { SimpleKey } from '../../i18n/t';

interface AccountRowProps {
  account: AccountRead;
  onEdit: (account: AccountRead) => void;
}

const TYPE_LABEL_KEY: Record<AccountRead['type'], SimpleKey> = {
  card: 'accounts.typeCard',
  cash: 'accounts.typeCash',
};

function AccountRowImpl({ account, onEdit }: AccountRowProps) {
  const t = useT();
  const styles = useStyles();
  const locale = useLocale();

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
          {t(TYPE_LABEL_KEY[account.type])} · {account.currency}
          {account.archived ? ` · ${t('common.archivedTag')}` : ''}
        </Text>
      </View>
      <Text style={[styles.balance, account.balance_minor < 0 && styles.negative]}>
        {formatMoney(account.balance_minor, account.currency, { locale })}
      </Text>
    </Pressable>
  );
}

const useStyles = themedStyles((t) => ({
  row: {
    minHeight: t.TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.md,
    paddingVertical: t.spacing.sm,
    paddingHorizontal: t.spacing.lg,
    backgroundColor: t.colors.surface,
  },
  icon: {
    fontSize: t.type.xl,
    width: 24,
    textAlign: 'center',
  },
  details: {
    flex: 1,
    gap: 2,
  },
  name: {
    fontSize: t.type.md,
    fontWeight: '500',
    color: t.colors.text,
  },
  archivedName: {
    color: t.colors.textMuted,
    fontStyle: 'italic',
  },
  meta: {
    fontSize: t.type.sm,
    color: t.colors.textMuted,
  },
  balance: {
    fontSize: t.type.md,
    fontWeight: '600',
    color: t.colors.text,
    ...t.tnum,
  },
  // Money in the minus, which is what this app already paints with the expense
  // red (web's rule, verbatim) — a real balance, not a sign test.
  negative: {
    color: t.colors.expense,
  },
}));

export const AccountRow = memo(AccountRowImpl);
