// The accounts tab (accounts-and-transfers MOB): what money lives where, and the
// only place accounts are created, renamed and archived.
//
// Every `balance_minor` comes from the server (architecture §2) — this screen sums
// nothing, converts nothing and shows no "total across accounts", because such a
// total would need an exchange rate the balances do not carry.
import { router } from 'expo-router';
import { useCallback, useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { EmptyState } from '../../../src/components/EmptyState';
import { FormButton } from '../../../src/components/FormButton';
import { themedStyles } from '../../../src/theme/themedStyles';
import { useAccounts, type AccountRead } from '../../../src/data/accounts';
import { sortForDisplay } from '../../../src/data/accountLookup';
import { AccountList } from '../../../src/features/accounts/AccountList';
import { useLocale, useT } from '../../../src/i18n/context';

export default function AccountsScreen() {
  const t = useT();
  const styles = useStyles();
  // The sort collator follows the INTERFACE language, not the device's — the
  // locale is part of the memo's identity so a language change re-sorts.
  const locale = useLocale();
  const accountsQuery = useAccounts();

  const sorted = useMemo(
    () => (accountsQuery.data ? sortForDisplay(accountsQuery.data, locale) : []),
    [accountsQuery.data, locale],
  );

  const openCreate = () => router.push({ pathname: '/account-form', params: {} });
  // Stable identity so the memoized AccountRow isn't re-rendered on every screen
  // render (the CategoriesScreen NIT-8 precedent).
  const openEdit = useCallback(
    (account: AccountRead) =>
      router.push({ pathname: '/account-form', params: { id: account.id } }),
    [],
  );

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <View style={styles.toolbar}>
        {/* N-4: no count while the list is unknown — "0 accounts" next to
            "Couldn't load your accounts." states a fact about data we do not
            have. */}
        {accountsQuery.isPending || accountsQuery.isError ? (
          <View />
        ) : (
          <Text style={styles.count}>{t('accountCount', { count: sorted.length })}</Text>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('accounts.add')}
          onPress={openCreate}
          style={styles.addButton}
        >
          <Text style={styles.addButtonText}>＋</Text>
        </Pressable>
      </View>

      {accountsQuery.isPending ? (
        <View style={styles.stateBox}>
          {[0, 1, 2].map((i) => (
            <View key={i} style={styles.skeletonRow} />
          ))}
        </View>
      ) : accountsQuery.isError ? (
        <EmptyState
          role="alert"
          title={t('accounts.loadFailed')}
          action={
            <FormButton
              label={t('common.retry')}
              variant="secondary"
              onPress={() => accountsQuery.refetch()}
            />
          }
        />
      ) : sorted.length === 0 ? (
        <EmptyState
          title={t('accounts.empty')}
          action={<FormButton label={t('accounts.add')} onPress={openCreate} />}
        />
      ) : (
        <AccountList accounts={sorted} onEdit={openEdit} />
      )}
    </SafeAreaView>
  );
}

const useStyles = themedStyles((t) => ({
  safe: {
    flex: 1,
    backgroundColor: t.colors.bg,
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: t.spacing.lg,
    paddingVertical: t.spacing.sm,
  },
  count: {
    fontSize: t.type.sm,
    color: t.colors.textMuted,
  },
  addButton: {
    width: t.TOUCH_TARGET,
    height: t.TOUCH_TARGET,
    borderRadius: t.TOUCH_TARGET / 2,
    backgroundColor: t.colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addButtonText: {
    color: t.colors.accentFg,
    fontSize: t.type.xxl,
    lineHeight: 30,
  },
  stateBox: {
    padding: t.spacing.lg,
    gap: t.spacing.md,
  },
  skeletonRow: {
    height: 56,
    borderRadius: t.radius.sm,
    backgroundColor: t.colors.surfaceMuted,
  },
}));
