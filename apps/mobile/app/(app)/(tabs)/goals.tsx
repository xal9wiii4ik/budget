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
import { ThemedSwitch } from '../../../src/components/ThemedSwitch';
import { useCallback, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { EmptyState } from '../../../src/components/EmptyState';
import { FormButton } from '../../../src/components/FormButton';
import { themedStyles } from '../../../src/theme/themedStyles';
import { useGoals, type GoalRead } from '../../../src/data/goals';
import { FreeBalanceSummary } from '../../../src/features/goals/FreeBalanceSummary';
import { GoalCard } from '../../../src/features/goals/GoalCard';
import { useT } from '../../../src/i18n/context';

export default function GoalsScreen() {
  const t = useT();
  const styles = useStyles();
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
          <ThemedSwitch value={includeArchived} onValueChange={setIncludeArchived} />
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
        <EmptyState
          role="alert"
          title={t('goals.loadFailed')}
          action={
            <FormButton
              label={t('common.retry')}
              variant="secondary"
              onPress={() => goalsQuery.refetch()}
            />
          }
        />
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
            <EmptyState
              title={t('goals.emptyTitle')}
              description={t('goals.emptyBody')}
              action={<FormButton label={t('goals.newGoal')} onPress={openCreate} />}
            />
          }
        />
      ) : null}
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
  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.sm,
    minHeight: t.TOUCH_TARGET,
  },
  toggleLabel: {
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
  listContent: {
    padding: t.spacing.lg,
    paddingTop: 0,
    gap: t.spacing.md,
  },
  header: {
    gap: t.spacing.sm,
    marginBottom: t.spacing.md,
  },
  // "We could not judge whether these goals are reachable" is a warning about the
  // screen, not money going out.
  notice: {
    fontSize: t.type.sm,
    color: t.colors.warning,
  },
  stateBox: {
    padding: t.spacing.lg,
    gap: t.spacing.md,
  },
  skeletonCard: {
    height: 160,
    borderRadius: t.radius.lg,
    backgroundColor: t.colors.surfaceMuted,
  },
}));
