// A single category row (memoized). System categories are edit-gated (W9): they
// render as a non-interactive row with a "System" tag and no press affordance; the
// server 403 is the backstop. User categories render as a Pressable that opens the
// edit modal. Swatch uses the stored color (fallback grey).
import type { components } from '@budget/api-client';
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, spacing, TOUCH_TARGET } from '../../components/theme';

type CategoryRead = components['schemas']['CategoryRead'];

interface CategoryRowProps {
  category: CategoryRead;
  onEdit: (category: CategoryRead) => void;
}

function CategoryRowImpl({ category, onEdit }: CategoryRowProps) {
  const content = (
    <>
      <View style={[styles.swatch, { backgroundColor: category.color ?? colors.swatchEmpty }]} />
      <Text style={styles.icon}>{category.icon ?? '•'}</Text>
      <Text style={[styles.name, category.archived && styles.archivedName]} numberOfLines={1}>
        {category.name}
      </Text>
      <View style={styles.tags}>
        {category.archived ? <Text style={styles.tag}>Archived</Text> : null}
        {category.is_system ? <Text style={styles.tag}>System</Text> : null}
      </View>
    </>
  );

  if (category.is_system) {
    return <View style={styles.row}>{content}</View>;
  }

  return (
    <Pressable accessibilityRole="button" onPress={() => onEdit(category)} style={styles.row}>
      {content}
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
  swatch: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: colors.border,
  },
  icon: {
    fontSize: 18,
    width: 22,
    textAlign: 'center',
  },
  name: {
    flex: 1,
    fontSize: 15,
    color: colors.text,
  },
  archivedName: {
    color: colors.textMuted,
    fontStyle: 'italic',
  },
  tags: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  tag: {
    fontSize: 11,
    color: colors.textMuted,
    backgroundColor: colors.bg,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    overflow: 'hidden',
  },
});

export const CategoryRow = memo(CategoryRowImpl);
