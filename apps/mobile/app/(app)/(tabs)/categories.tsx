import type { components } from '@budget/api-client';
import { router } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useCategories } from '../../../src/data/categories';
import { sortForDisplay } from '../../../src/data/categoryLookup';
import { CategoryList } from '../../../src/features/categories/CategoryList';
import { filterCategories } from '../../../src/features/categories/categorySearch';
import { FormButton } from '../../../src/components/FormButton';
import { colors, spacing, TOUCH_TARGET } from '../../../src/components/theme';
import { useLocale, useT } from '../../../src/i18n/context';

type CategoryRead = components['schemas']['CategoryRead'];

export default function CategoriesScreen() {
  const t = useT();
  // The collator follows the INTERFACE language (part of the memo's identity).
  const locale = useLocale();
  const categoriesQuery = useCategories();
  // catch-up 3 line A: a CLIENT-side search. The whole archived-inclusive list is
  // already in one cache entry, so filtering it here costs no request and needs no
  // debounce — nothing downstream is keyed on this string.
  const [search, setSearch] = useState('');

  const sorted = useMemo(
    () => (categoriesQuery.data ? sortForDisplay(categoriesQuery.data, locale) : []),
    [categoriesQuery.data, locale],
  );
  const visible = useMemo(
    () => filterCategories(sorted, search, locale),
    [sorted, search, locale],
  );
  const searching = search.trim() !== '';

  const openCreate = () => router.push({ pathname: '/category-form', params: {} });
  // Stable identity so the memoized CategoryRow isn't re-rendered on every screen
  // render (NIT 8).
  const openEdit = useCallback(
    (category: CategoryRead) => router.push({ pathname: '/category-form', params: { id: category.id } }),
    [],
  );
  // The drill-down is a PUSHED screen, not a modal: web opens a window over
  // /categories, but on a phone a window over a list is a screen, and the back
  // gesture (iOS swipe, Android back) is the way out people already know.
  const openTransactions = useCallback(
    (category: CategoryRead) =>
      router.push({ pathname: '/category-transactions', params: { id: category.id } }),
    [],
  );

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <View style={styles.toolbar}>
        {/* N-4 (same reasoning as the accounts tab): no count for a list we
            could not load. While a search is on, the count describes what is on
            screen — a total that disagrees with the visible rows is worse than none. */}
        {categoriesQuery.isPending || categoriesQuery.isError ? (
          <View />
        ) : (
          <Text style={styles.count}>{t('categoryCount', { count: visible.length })}</Text>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('categories.add')}
          onPress={openCreate}
          style={styles.addButton}
        >
          <Text style={styles.addButtonText}>＋</Text>
        </Pressable>
      </View>

      {/* Offered only once there is a list to search: a box over a skeleton or an
          error is a control that cannot do anything. */}
      {categoriesQuery.data === undefined ? null : (
        <View style={styles.searchRow}>
          <TextInput
            accessibilityLabel={t('categories.searchLabel')}
            style={styles.searchInput}
            value={search}
            onChangeText={setSearch}
            placeholder={t('categories.searchPlaceholder')}
            placeholderTextColor={colors.textMuted}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
          />
          {searching ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('categories.searchClearAction')}
              onPress={() => setSearch('')}
              style={styles.searchClear}
            >
              <Text style={styles.searchClearText}>×</Text>
            </Pressable>
          ) : null}
        </View>
      )}

      {categoriesQuery.isPending ? (
        <View style={styles.stateBox}>
          {[0, 1, 2, 3].map((i) => (
            <View key={i} style={styles.skeletonRow} />
          ))}
        </View>
      ) : categoriesQuery.isError ? (
        <View style={styles.stateBox}>
          <Text accessibilityRole="alert" style={styles.error}>
            {t('categories.loadFailed')}
          </Text>
          <FormButton
            label={t('common.retry')}
            variant="secondary"
            onPress={() => categoriesQuery.refetch()}
          />
        </View>
      ) : visible.length === 0 ? (
        // Two different emptinesses, and only one of them is answered by "add one":
        // a search that matches nothing is answered by clearing the search.
        <View style={styles.stateBox}>
          <Text style={styles.emptyText}>
            {searching
              ? t('categories.searchEmpty', { query: search.trim() })
              : t('categories.empty')}
          </Text>
          {searching ? (
            <FormButton
              label={t('categories.searchClearAction')}
              variant="secondary"
              onPress={() => setSearch('')}
            />
          ) : (
            <FormButton label={t('categories.add')} onPress={openCreate} />
          )}
        </View>
      ) : (
        <CategoryList
          categories={visible}
          onEdit={openEdit}
          onOpenTransactions={openTransactions}
        />
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
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  searchInput: {
    flex: 1,
    minHeight: TOUCH_TARGET,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    fontSize: 16,
    color: colors.text,
    backgroundColor: colors.card,
  },
  searchClear: {
    width: TOUCH_TARGET,
    height: TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchClearText: {
    fontSize: 24,
    lineHeight: 26,
    color: colors.textMuted,
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
