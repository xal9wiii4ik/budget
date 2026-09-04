// The accounts tab (accounts-and-transfers MOB): what money lives where, and the
// only place accounts are created, renamed and archived.
//
// Every `balance_minor` comes from the server (architecture §2) — this screen sums
// nothing, converts nothing and shows no "total across accounts", because such a
// total would need an exchange rate the balances do not carry.
import { router } from 'expo-router';
import { useCallback, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FormButton } from '../../../src/components/FormButton';
import { colors, spacing, TOUCH_TARGET } from '../../../src/components/theme';
import { useAccounts, type AccountRead } from '../../../src/data/accounts';
import { sortForDisplay } from '../../../src/data/accountLookup';
import { AccountList } from '../../../src/features/accounts/AccountList';
import { useLocale, useT } from '../../../src/i18n/context';

export default function AccountsScreen() {
  const t = useT();
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
        <View style={styles.stateBox}>
          <Text accessibilityRole="alert" style={styles.error}>
            {t('accounts.loadFailed')}
          </Text>
          <FormButton
            label={t('common.retry')}
            variant="secondary"
            onPress={() => accountsQuery.refetch()}
          />
        </View>
      ) : sorted.length === 0 ? (
        <View style={styles.stateBox}>
          <Text style={styles.emptyText}>{t('accounts.empty')}</Text>
          <FormButton label={t('accounts.add')} onPress={openCreate} />
        </View>
      ) : (
        <AccountList accounts={sorted} onEdit={openEdit} />
      )}
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
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  count: {
    fontSize: 14,
    color: colors.textMuted,
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
  stateBox: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  skeletonRow: {
    height: 56,
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
});
