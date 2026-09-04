// The accounts tab's list: live accounts first, archived ones in their own
// quieter section (the CategoryList pattern — SectionList, keyExtractor by id,
// memoized rows; never .map inside a ScrollView).
//
// Two groups rather than a flat list with tags: an archived account is not part
// of "what I have" — it is history that must stay reachable (its balance still
// explains past rows), which is exactly what a separate section says.
//
// No "total across accounts" anywhere: balances are per-account integers in
// different currencies, and adding them would need a rate they do not carry.
import { useMemo } from 'react';
import { SectionList, StyleSheet, Text, View } from 'react-native';

import { colors, spacing } from '../../components/theme';
import type { AccountRead } from '../../data/accounts';
import { useT } from '../../i18n/context';
import { AccountRow } from './AccountRow';

interface AccountListProps {
  /** Already display-sorted (data/accountLookup sortForDisplay). */
  accounts: AccountRead[];
  onEdit: (account: AccountRead) => void;
}

interface AccountSection {
  title: string;
  archived: boolean;
  data: AccountRead[];
}

export function AccountList({ accounts, onEdit }: AccountListProps) {
  const t = useT();

  const sections = useMemo<AccountSection[]>(() => {
    const groups: AccountSection[] = [
      { title: t('accounts.group'), archived: false, data: [] },
      { title: t('accounts.archivedGroup'), archived: true, data: [] },
    ];
    for (const account of accounts) {
      const group = groups.find((g) => g.archived === account.archived);
      group?.data.push(account);
    }
    return groups.filter((group) => group.data.length > 0);
  }, [accounts, t]);

  return (
    <SectionList
      sections={sections}
      keyExtractor={(item) => item.id}
      stickySectionHeadersEnabled={false}
      renderSectionHeader={({ section }) => (
        <Text style={styles.groupTitle}>{(section as AccountSection).title}</Text>
      )}
      renderItem={({ item }) => <AccountRow account={item} onEdit={onEdit} />}
      ItemSeparatorComponent={() => <View style={styles.separator} />}
      contentContainerStyle={styles.content}
    />
  );
}

const styles = StyleSheet.create({
  content: {
    paddingBottom: spacing.xl,
  },
  groupTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    backgroundColor: colors.bg,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xs,
  },
  separator: {
    height: 1,
    backgroundColor: colors.border,
    marginLeft: spacing.lg,
  },
});
