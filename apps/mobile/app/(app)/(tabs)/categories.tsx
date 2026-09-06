import type { components } from '@budget/api-client';
import { router } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useCategories } from '../../../src/data/categories';
import { sortForDisplay } from '../../../src/data/categoryLookup';
import { CategoryList } from '../../../src/features/categories/CategoryList';
import { filterCategories } from '../../../src/features/categories/categorySearch';
import { EmptyState } from '../../../src/components/EmptyState';
import { FormButton } from '../../../src/components/FormButton';
import { themedStyles } from '../../../src/theme/themedStyles';
import { useTheme } from '../../../src/theme/useTheme';
import { useLocale, useT } from '../../../src/i18n/context';

type CategoryRead = components['schemas']['CategoryRead'];

export default function CategoriesScreen() {
  const t = useT();
  const styles = useStyles();
  const { scheme, colors } = useTheme();
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
            placeholderTextColor={colors.textSubtle}
            // The keyboard is a system surface: without this it stays light while
            // the app is dark.
            keyboardAppearance={scheme}
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
        <EmptyState
          role="alert"
          title={t('categories.loadFailed')}
          action={
            <FormButton
              label={t('common.retry')}
              variant="secondary"
              onPress={() => categoriesQuery.refetch()}
            />
          }
        />
      ) : visible.length === 0 ? (
        // Two different emptinesses, and only one of them is answered by "add one":
        // a search that matches nothing is answered by clearing the search.
        <EmptyState
          title={
            searching
              ? t('categories.searchEmpty', { query: search.trim() })
              : t('categories.empty')
          }
          action={
            searching ? (
              <FormButton
                label={t('categories.searchClearAction')}
                variant="secondary"
                onPress={() => setSearch('')}
              />
            ) : (
              <FormButton label={t('categories.add')} onPress={openCreate} />
            )
          }
        />
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

const useStyles = themedStyles((t) => ({
  safe: {
    flex: 1,
    backgroundColor: t.colors.bg,
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: t.spacing.lg,
    paddingVertical: t.spacing.sm,
  },
  count: {
    fontSize: t.type.sm,
    color: t.colors.textMuted,
  },
  addButton: {
    width: t.TOUCH_TARGET,
    height: t.TOUCH_TARGET,
    borderRadius: t.TOUCH_TARGET / 2,
    backgroundColor: t.colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addButtonText: {
    color: t.colors.accentFg,
    fontSize: t.type.xl,
    lineHeight: 28,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.sm,
    paddingHorizontal: t.spacing.lg,
    paddingBottom: t.spacing.sm,
  },
  searchInput: {
    flex: 1,
    minHeight: t.TOUCH_TARGET,
    borderWidth: 1,
    borderColor: t.colors.borderStrong,
    borderRadius: t.radius.md,
    paddingHorizontal: t.spacing.md,
    fontSize: t.type.md,
    color: t.colors.text,
    backgroundColor: t.colors.surface,
  },
  searchClear: {
    width: t.TOUCH_TARGET,
    height: t.TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchClearText: {
    fontSize: t.type.xl,
    lineHeight: 26,
    color: t.colors.textSubtle,
  },
  stateBox: {
    padding: t.spacing.lg,
    gap: t.spacing.md,
  },
  skeletonRow: {
    height: 48,
    borderRadius: t.radius.sm,
    backgroundColor: t.colors.surfaceMuted,
  },
}));
