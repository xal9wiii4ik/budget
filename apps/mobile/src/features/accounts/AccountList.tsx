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
import { SectionList, Text, View } from 'react-native';

import { themedStyles } from '../../theme/themedStyles';
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
  const styles = useStyles();

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

// The list is not wrapped in a `Card`: it IS the screen's scroller, and an
// unbounded SectionList inside a bordered, clipping box is the layout that cost
// this app a screen that would not scroll at all. What web's card buys — surface
// rows, hairlines between them, quiet group titles — is drawn here instead, with
// the rows running edge to edge the way a phone list does.
const useStyles = themedStyles((t) => ({
  content: {
    paddingBottom: t.spacing.xl,
  },
  groupTitle: {
    fontSize: t.type.xs,
    fontWeight: '700',
    color: t.colors.textMuted,
    textTransform: 'uppercase',
    backgroundColor: t.colors.bg,
    paddingHorizontal: t.spacing.lg,
    paddingTop: t.spacing.lg,
    paddingBottom: t.spacing.xs,
  },
  separator: {
    height: 1,
    backgroundColor: t.colors.border,
    marginLeft: t.spacing.lg,
  },
}));
