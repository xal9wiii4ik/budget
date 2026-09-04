// Kind-grouped category list (SectionList). Input is pre-sorted (sortForDisplay),
// so grouping by kind preserves the locale-aware within-group order. Expense section
// first, then Income.
import type { components } from '@budget/api-client';
import { useMemo } from 'react';
import { SectionList, StyleSheet, Text, View } from 'react-native';

import { colors, spacing } from '../../components/theme';
import { useT } from '../../i18n/context';
import { CategoryRow } from './CategoryRow';

type CategoryRead = components['schemas']['CategoryRead'];

interface CategoryListProps {
  categories: CategoryRead[];
  onEdit: (category: CategoryRead) => void;
}

interface KindSection {
  title: string;
  kind: CategoryRead['kind'];
  data: CategoryRead[];
}

export function CategoryList({ categories, onEdit }: CategoryListProps) {
  const t = useT();

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
    <SectionList
      sections={sections}
      keyExtractor={(item) => item.id}
      stickySectionHeadersEnabled={false}
      renderSectionHeader={({ section }) => (
        <Text style={styles.groupTitle}>{(section as KindSection).title}</Text>
      )}
      renderItem={({ item }) => <CategoryRow category={item} onEdit={onEdit} />}
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
