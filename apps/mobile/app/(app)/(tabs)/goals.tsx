// The goals tab (mobile-catchup-3, line C): what the user is saving for, what it
// costs, and how far along it is.
//
// Everything on it is a SERVER field — the free balance and its BASIS, the three
// progress figures, realism, the waterfall allocation. This screen sums nothing
// and converts nothing; the one thing it owns is the "show archived" preference,
// which is genuine client state (a view preference, not server data) and lives in
// the query KEY, so the two variants are separate cache entries.
//
// A card opens the PLAN screen; the pencil opens the goal form. Contributions and
// the plan itself live one screen deeper, because a card that tried to hold a
// tree, a ledger and a form would hold none of them well on a phone.
import { router } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FormButton } from '../../../src/components/FormButton';
import { colors, spacing, TOUCH_TARGET } from '../../../src/components/theme';
import { useGoals, type GoalRead } from '../../../src/data/goals';
import { FreeBalanceSummary } from '../../../src/features/goals/FreeBalanceSummary';
import { GoalCard } from '../../../src/features/goals/GoalCard';
import { useT } from '../../../src/i18n/context';

export default function GoalsScreen() {
  const t = useT();
  const [includeArchived, setIncludeArchived] = useState(false);
  const goalsQuery = useGoals(includeArchived);
  const list = goalsQuery.data;

  // No params: the form reads the goals list itself for the profile base
  // currency (its default pick — never guessed), which makes it deep-link-safe
  // and keeps this screen from having to be loaded for it to work.
  const openCreate = useCallback(() => router.push('/goal-form'), []);

  // Stable identities so the memoized card is not re-rendered on every screen
  // render.
  const openPlan = useCallback(
    (goal: GoalRead) => router.push({ pathname: '/goal-plan', params: { id: goal.id } }),
    [],
  );
  const openEdit = useCallback((goal: GoalRead) => {
    router.push({ pathname: '/goal-form', params: { id: goal.id } });
  }, []);

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <View style={styles.toolbar}>
        <View style={styles.toggle}>
          <Switch value={includeArchived} onValueChange={setIncludeArchived} />
          <Text style={styles.toggleLabel}>{t('goals.showArchived')}</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('goals.newGoal')}
          onPress={openCreate}
          style={styles.addButton}
        >
          <Text style={styles.addButtonText}>＋</Text>
        </Pressable>
      </View>

      {goalsQuery.isPending ? (
        <View style={styles.stateBox}>
          {[0, 1].map((i) => (
            <View key={i} style={styles.skeletonCard} />
          ))}
        </View>
      ) : goalsQuery.isError ? (
        <View style={styles.stateBox}>
          <Text accessibilityRole="alert" style={styles.error}>
            {t('goals.loadFailed')}
          </Text>
          <FormButton
            label={t('common.retry')}
            variant="secondary"
            onPress={() => goalsQuery.refetch()}
          />
        </View>
      ) : list ? (
        <FlatList
          data={list.items}
          keyExtractor={(goal) => goal.id}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => (
            <GoalCard goal={item} onOpen={openPlan} onEdit={openEdit} />
          )}
          ListHeaderComponent={
            <View style={styles.header}>
              {/* What the number MEANS depends on what the server could compute it
                  from — the whole switch, incl. the month window, is in the
                  component. Never rendered in a loading or error arm: it would be
                  a claim about numbers that are not on screen. */}
              <FreeBalanceSummary list={list} />
              {list.realism_unavailable ? (
                <Text style={styles.notice}>{t('goals.realismUnavailable')}</Text>
              ) : null}
            </View>
          }
          ListEmptyComponent={
            <View style={styles.stateBox}>
              <Text style={styles.emptyTitle}>{t('goals.emptyTitle')}</Text>
              <Text style={styles.emptyBody}>{t('goals.emptyBody')}</Text>
              <FormButton label={t('goals.newGoal')} onPress={openCreate} />
            </View>
          }
        />
      ) : null}
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
  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: TOUCH_TARGET,
  },
  toggleLabel: {
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
  listContent: {
    padding: spacing.lg,
    paddingTop: 0,
    gap: spacing.md,
  },
  header: {
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  notice: {
    fontSize: 13,
    color: colors.expense,
  },
  stateBox: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  skeletonCard: {
    height: 160,
    borderRadius: 12,
    backgroundColor: colors.border,
  },
  error: {
    color: colors.danger,
    fontSize: 14,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'center',
  },
  emptyBody: {
    fontSize: 14,
    color: colors.textMuted,
    textAlign: 'center',
  },
});
