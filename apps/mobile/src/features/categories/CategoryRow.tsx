// A single category row (memoized). System categories are edit-gated (W9): they
// render with a "System" tag and no EDIT affordance; the server 403 is the backstop.
// User categories render as a Pressable that opens the edit modal. Swatch uses the
// stored color (fallback grey).
//
// catch-up 3 line A: every row also carries a DRILL affordance to its operations —
// system rows included. "Not editable" and "not readable" are different things, and
// a system category (Groceries, Salary) is exactly the one people most want to open;
// gating the drill on `is_system` would hide the feature behind the rows that use it
// most. The two live side by side: the row body edits (user rows only), the chevron
// drills (always).
import type { components } from '@budget/api-client';
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, spacing, TOUCH_TARGET } from '../../components/theme';
import { useT } from '../../i18n/context';

type CategoryRead = components['schemas']['CategoryRead'];

interface CategoryRowProps {
  category: CategoryRead;
  onEdit: (category: CategoryRead) => void;
  onOpenTransactions: (category: CategoryRead) => void;
}

function CategoryRowImpl({ category, onEdit, onOpenTransactions }: CategoryRowProps) {
  const t = useT();

  const content = (
    <>
      <View style={[styles.swatch, { backgroundColor: category.color ?? colors.swatchEmpty }]} />
      <Text style={styles.icon}>{category.icon ?? '•'}</Text>
      <Text style={[styles.name, category.archived && styles.archivedName]} numberOfLines={1}>
        {category.name}
      </Text>
      <View style={styles.tags}>
        {category.archived ? (
          <Text style={styles.tag}>{t('common.archivedTag')}</Text>
        ) : null}
        {category.is_system ? (
          <Text style={styles.tag}>{t('categories.systemTag')}</Text>
        ) : null}
      </View>
    </>
  );

  // Its own control, not a second gesture on the row: a long-press or a swipe would
  // be an affordance nobody can see, and the two actions are peers.
  const drill = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('categories.viewTransactionsFor', { name: category.name })}
      onPress={() => onOpenTransactions(category)}
      style={styles.drill}
    >
      <Text style={styles.drillText}>›</Text>
    </Pressable>
  );

  if (category.is_system) {
    return (
      <View style={styles.row}>
        <View style={styles.body}>{content}</View>
        {drill}
      </View>
    );
  }

  return (
    <View style={styles.row}>
      {/* The editable part is the row BODY, so the chevron beside it keeps its own
          44pt target instead of living inside another button. */}
      <Pressable
        accessibilityRole="button"
        onPress={() => onEdit(category)}
        style={styles.body}
      >
        {content}
      </Pressable>
      {drill}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    paddingLeft: spacing.lg,
    paddingRight: spacing.xs,
    backgroundColor: colors.card,
  },
  // The row's contents, whether or not they are pressable — so a system row and a
  // user row line up under each other pixel for pixel.
  body: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: TOUCH_TARGET,
  },
  drill: {
    width: TOUCH_TARGET,
    minHeight: TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  drillText: {
    fontSize: 24,
    lineHeight: 26,
    color: colors.primary,
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
