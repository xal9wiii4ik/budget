import type { components } from '@budget/api-client';
import { router } from 'expo-router';
import { useCallback, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useCategories } from '../../../src/data/categories';
import { sortForDisplay } from '../../../src/data/categoryLookup';
import { CategoryList } from '../../../src/features/categories/CategoryList';
import { FormButton } from '../../../src/components/FormButton';
import { colors, spacing, TOUCH_TARGET } from '../../../src/components/theme';
import { APP_LOCALE } from '../../../src/lib/locale';

type CategoryRead = components['schemas']['CategoryRead'];

export default function CategoriesScreen() {
  const categoriesQuery = useCategories();

  const sorted = useMemo(
    () => (categoriesQuery.data ? sortForDisplay(categoriesQuery.data, APP_LOCALE) : []),
    [categoriesQuery.data],
  );

  const openCreate = () => router.push({ pathname: '/category-form', params: {} });
  // Stable identity so the memoized CategoryRow isn't re-rendered on every screen
  // render (NIT 8).
  const openEdit = useCallback(
    (category: CategoryRead) => router.push({ pathname: '/category-form', params: { id: category.id } }),
    [],
  );

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <View style={styles.toolbar}>
        <Text style={styles.count}>{sorted.length} categories</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add category"
          onPress={openCreate}
          style={styles.addButton}
        >
          <Text style={styles.addButtonText}>＋</Text>
        </Pressable>
      </View>

      {categoriesQuery.isPending ? (
        <View style={styles.stateBox}>
          {[0, 1, 2, 3].map((i) => (
            <View key={i} style={styles.skeletonRow} />
          ))}
        </View>
      ) : categoriesQuery.isError ? (
        <View style={styles.stateBox}>
          <Text accessibilityRole="alert" style={styles.error}>
            Couldn&apos;t load your categories.
          </Text>
          <FormButton label="Retry" variant="secondary" onPress={() => categoriesQuery.refetch()} />
        </View>
      ) : sorted.length === 0 ? (
        <View style={styles.stateBox}>
          <Text style={styles.emptyText}>No categories yet.</Text>
          <FormButton label="Add category" onPress={openCreate} />
        </View>
      ) : (
        <CategoryList categories={sorted} onEdit={openEdit} />
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
    height: 48,
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
