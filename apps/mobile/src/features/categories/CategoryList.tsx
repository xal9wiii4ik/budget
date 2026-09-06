// Kind-grouped category list (SectionList). Input is pre-sorted (sortForDisplay),
// so grouping by kind preserves the locale-aware within-group order. Expense section
// first, then Income.
//
// mobile-design line C: the rows live inside ONE `Card padding="none"` with
// hairline separators — the list rule. A card per row would turn the scroll into a
// stack of floating boxes and double every border; the section titles stay inside
// the card as muted bands, which is what makes the two groups readable without
// each becoming a box of its own.
import type { components } from '@budget/api-client';
import { useMemo } from 'react';
import { SectionList, Text, View } from 'react-native';

import { Card } from '../../components/Card';
import { themedStyles } from '../../theme/themedStyles';
import { useT } from '../../i18n/context';
import { CategoryRow } from './CategoryRow';

type CategoryRead = components['schemas']['CategoryRead'];

interface CategoryListProps {
  categories: CategoryRead[];
  onEdit: (category: CategoryRead) => void;
  /** catch-up 3 line A: the drill into this category's operations. */
  onOpenTransactions: (category: CategoryRead) => void;
}

interface KindSection {
  title: string;
  kind: CategoryRead['kind'];
  data: CategoryRead[];
}

export function CategoryList({
  categories,
  onEdit,
  onOpenTransactions,
}: CategoryListProps) {
  const t = useT();
  const styles = useStyles();

  const sections = useMemo<KindSection[]>(() => {
    const groups: KindSection[] = [
      { title: t('common.expense'), kind: 'expense', data: [] },
      { title: t('common.income'), kind: 'income', data: [] },
    ];
    for (const category of categories) {
      const group = groups.find((g) => g.kind === category.kind);
      group?.data.push(category);
    }
    return groups.filter((group) => group.data.length > 0);
  }, [categories, t]);

  return (
    <Card padding="none" style={styles.card}>
      <SectionList
        style={styles.list}
        sections={sections}
        keyExtractor={(item) => item.id}
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section }) => (
          <Text style={styles.groupTitle}>{(section as KindSection).title}</Text>
        )}
        renderItem={({ item }) => (
          <CategoryRow
            category={item}
            onEdit={onEdit}
            onOpenTransactions={onOpenTransactions}
          />
        )}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        contentContainerStyle={styles.content}
      />
    </Card>
  );
}

const useStyles = themedStyles((t) => ({
  card: {
    flex: 1,
    marginHorizontal: t.spacing.lg,
    marginBottom: t.spacing.lg,
  },
  list: {
    flex: 1,
  },
  content: {
    paddingBottom: t.spacing.sm,
  },
  groupTitle: {
    fontSize: t.type.sm,
    fontWeight: '700',
    color: t.colors.textMuted,
    textTransform: 'uppercase',
    backgroundColor: t.colors.surfaceMuted,
    paddingHorizontal: t.spacing.lg,
    paddingTop: t.spacing.md,
    paddingBottom: t.spacing.xs,
  },
  separator: {
    height: 1,
    backgroundColor: t.colors.border,
    marginLeft: t.spacing.lg,
  },
}));
