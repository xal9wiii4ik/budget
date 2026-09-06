// The recurring-templates screen (catch-up 3, line B) — mobile's counterpart of
// web's /recurring.
//
// It is a PUSHED screen off the "More" tab rather than a tab of its own:
// materialization is silent, so this is the screen that answers "where did this
// row come from", but it is not a place anyone spends their day. The upcoming
// widget on the transactions tab is what surfaces the schedule day to day.
//
// The list shows EVERY template, paused and ended included: it is the management
// screen — a paused template is what the user came to resume and an ended one is
// what they came to delete (the delete itself lives in the form).
import { router, Stack } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FormButton } from '../../src/components/FormButton';
import { colors, spacing, TOUCH_TARGET } from '../../src/components/theme';
import { useCategories } from '../../src/data/categories';
import { buildCategoryIndex } from '../../src/data/categoryLookup';
import { describeRecurringError } from '../../src/data/errors';
import {
  useRecurringTemplates,
  useUpdateTemplate,
  type RecurringTemplateRead,
} from '../../src/data/recurring';
import { TemplateRow } from '../../src/features/recurring/TemplateRow';
import { useLang, useT } from '../../src/i18n/context';

export default function RecurringScreen() {
  const t = useT();
  const lang = useLang();
  const templatesQuery = useRecurringTemplates();
  const categoriesQuery = useCategories();
  const updateTemplate = useUpdateTemplate();

  // One mutation object serves every row, so the ID is what disables the right
  // button; the error is the LAST failed toggle's, shown above the list.
  const [pausingId, setPausingId] = useState<string | null>(null);
  const [pauseError, setPauseError] = useState<string | null>(null);

  const categoryIndex = useMemo(
    () => buildCategoryIndex(categoriesQuery.data ?? []),
    [categoriesQuery.data],
  );

  const openCreate = () => router.push({ pathname: '/recurring-form', params: {} });
  // Stable identities so the memoized rows are not re-rendered on every screen
  // render (the accounts-tab precedent).
  const openEdit = useCallback(
    (template: RecurringTemplateRead) =>
      router.push({ pathname: '/recurring-form', params: { id: template.id } }),
    [],
  );

  const togglePause = useCallback(
    (template: RecurringTemplateRead) => {
      setPauseError(null);
      setPausingId(template.id);
      updateTemplate.mutate(
        { id: template.id, body: { paused: !template.paused } },
        {
          onError: (error) => setPauseError(describeRecurringError(error, lang).message),
          onSettled: () => setPausingId(null),
        },
      );
    },
    [lang, updateTemplate],
  );

  const templates = templatesQuery.data?.items ?? [];

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      {/* A real pushed screen: the native header gives it a back button and iOS
          swipe-back for free, and the title follows the interface language. */}
      <Stack.Screen
        options={{
          headerShown: true,
          title: t('recurring.title'),
          // Without this the back button reads "(tabs)" — the parent ROUTE's name,
          // which is an implementation detail of the file tree, not a place.
          headerBackTitle: t('tabs.more'),
          headerRight: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('recurring.newTemplate')}
              onPress={openCreate}
              hitSlop={8}
              style={styles.headerAdd}
            >
              <Text style={styles.headerAddText}>＋</Text>
            </Pressable>
          ),
        }}
      />

      {pauseError !== null ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {pauseError}
        </Text>
      ) : null}

      {templatesQuery.isPending ? (
        <View style={styles.stateBox}>
          {[0, 1, 2].map((index) => (
            <View key={index} style={styles.skeletonRow} />
          ))}
        </View>
      ) : templatesQuery.isError ? (
        // A flaky mobile network is a recoverable state, never a dead end.
        <View style={styles.stateBox}>
          <Text accessibilityRole="alert" style={styles.error}>
            {t('recurring.loadFailed')}
          </Text>
          <FormButton
            label={t('common.retry')}
            variant="secondary"
            onPress={() => templatesQuery.refetch()}
          />
        </View>
      ) : templates.length === 0 ? (
        <View style={styles.stateBox}>
          <Text style={styles.emptyTitle}>{t('recurring.emptyTitle')}</Text>
          <Text style={styles.emptyBody}>{t('recurring.emptyBody')}</Text>
          <FormButton label={t('recurring.newTemplate')} onPress={openCreate} />
        </View>
      ) : (
        <FlatList
          data={templates}
          keyExtractor={(template) => template.id}
          ListHeaderComponent={<Text style={styles.lede}>{t('recurring.lede')}</Text>}
          renderItem={({ item }) => (
            <TemplateRow
              template={item}
              category={
                item.category_id === null
                  ? undefined
                  : categoryIndex.get(item.category_id)
              }
              isPausePending={pausingId === item.id}
              onEdit={openEdit}
              onTogglePause={togglePause}
            />
          )}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          contentContainerStyle={styles.content}
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
  headerAdd: {
    minWidth: TOUCH_TARGET,
    minHeight: TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerAddText: {
    fontSize: 24,
    lineHeight: 28,
    color: colors.primary,
  },
  content: {
    paddingBottom: spacing.xl,
  },
  lede: {
    fontSize: 13,
    color: colors.textMuted,
    padding: spacing.lg,
  },
  stateBox: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  skeletonRow: {
    height: 76,
    borderRadius: 8,
    backgroundColor: colors.border,
  },
  error: {
    color: colors.danger,
    fontSize: 14,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
    textAlign: 'center',
  },
  emptyBody: {
    fontSize: 14,
    color: colors.textMuted,
    textAlign: 'center',
  },
  separator: {
    height: 1,
    backgroundColor: colors.border,
    marginLeft: spacing.lg,
  },
});
