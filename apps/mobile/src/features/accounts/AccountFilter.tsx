// The transactions list's account filter (accounts-and-transfers MOB, mirroring
// web's W2 control). NOT a form field: it edits the screen's filter state, which
// is part of the list's query key, so a filtered month and the all-accounts month
// are separate cache entries.
//
// ARCHIVED accounts are listed: archiving hides an account from NEW operations, it
// does not erase the history you may want to read.
//
// A horizontal FlatList rather than chips inside a ScrollView: the same long-list
// discipline the rest of the app follows, with keyExtractor by id.
//
// D-1: a bare horizontal FlatList is a flex child of the screen's column layout and
// stretched to the leftover height, pushing the summary below the fold. It is wrapped
// in a non-flexing View and pinned with `flexGrow: 0` so the control measures exactly
// one chip row.
//
// While the accounts query is loading, or if it failed, this renders NOTHING: the
// list below already carries that story, and claiming "All accounts" next to an
// empty chip row would be a statement about data we do not have.
import { FlatList, Pressable, Text, View } from 'react-native';

import { themedStyles } from '../../theme/themedStyles';
import type { AccountRead } from '../../data/accounts';
import { useT } from '../../i18n/context';

interface AccountFilterProps {
  /** The account currently filtered on, or null for "all accounts". */
  value: string | null;
  /** Already display-sorted (data/accountLookup sortForDisplay). */
  accounts: AccountRead[];
  onChange: (accountId: string | null) => void;
}

// The "all accounts" entry is part of the same list so it scrolls with the chips
// and needs no second control; `null` id is what the filter means by "no filter".
interface FilterOption {
  id: string | null;
  label: string;
}

export function AccountFilter({ value, accounts, onChange }: AccountFilterProps) {
  const t = useT();
  const styles = useStyles();

  if (accounts.length === 0) return null;

  // Account names and currency codes are data; only "All accounts" and the
  // archived marker are copy.
  const options: FilterOption[] = [
    { id: null, label: t('accounts.all') },
    ...accounts.map((account) => ({
      id: account.id,
      label: `${account.name} · ${account.currency}${
        account.archived ? ` ${t('common.archivedParens')}` : ''
      }`,
    })),
  ];

  return (
    <View style={styles.wrap}>
      <FlatList
        horizontal
        data={options}
        keyExtractor={(item) => item.id ?? 'all'}
        showsHorizontalScrollIndicator={false}
        style={styles.list}
        contentContainerStyle={styles.content}
        ItemSeparatorComponent={() => <View style={styles.gap} />}
        renderItem={({ item }) => {
          const selected = item.id === value;
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected }}
              onPress={() => onChange(item.id)}
              style={[styles.chip, selected && styles.chipSelected]}
            >
              <Text style={[styles.chipText, selected && styles.chipTextSelected]}>
                {item.label}
              </Text>
            </Pressable>
          );
        }}
      />
    </View>
  );
}

const useStyles = themedStyles((t) => ({
  // No `flex` here: the wrapper takes its height from the chip row it contains.
  wrap: {
    flexGrow: 0,
    flexShrink: 0,
  },
  list: {
    flexGrow: 0,
    flexShrink: 0,
  },
  content: {
    paddingHorizontal: t.spacing.lg,
    paddingBottom: t.spacing.sm,
    alignItems: 'center',
  },
  gap: {
    width: t.spacing.sm,
  },
  chip: {
    minHeight: t.TOUCH_TARGET - 8,
    paddingHorizontal: t.spacing.md,
    paddingVertical: t.spacing.sm,
    borderRadius: t.radius.full,
    borderWidth: 1,
    borderColor: t.colors.border,
    backgroundColor: t.colors.surface,
    justifyContent: 'center',
  },
  chipSelected: t.selected.chip,
  chipText: {
    fontSize: t.type.sm,
    color: t.colors.text,
  },
  chipTextSelected: t.selected.text,
}));
