// One goal as a PLAN: the cost block, the three progress figures, the tree — and,
// behind a segment, the contribution ledger (mobile-catchup-3, line C).
//
// PUSHED, not modal: it is a destination, not a form, and it must survive a
// back-swipe / Android back into the goals tab.
//
// Both reads are per-goal and single: `GET /goals/{id}` (the plan fields come from
// the single response, never from a cached list a deep link would not have) and
// `GET /goals/{id}/items`, which returns the WHOLE tree in one request. There is
// no per-node query, by design.
//
// Every number is a server field. The only things derived here are the SHAPE of
// the tree (`buildTree`, @budget/api-client — shared with web) and the size of a
// subtree for the delete confirm's copy.
//
// ONE FlatList, two datasets: the flattened tree, or the ledger. A phone cannot
// nest a second unbounded list inside a scroll view, and the summary above them
// is the same context for both.
import { buildTree, descendantCount, type PlanNode } from '@budget/api-client';
import { formatApiDate, formatMoney, todayApiDateUtc } from '@budget/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { confirmAction } from '../../src/components/confirm';
import { EmptyState } from '../../src/components/EmptyState';
import { FormButton } from '../../src/components/FormButton';
import { themedStyles } from '../../src/theme/themedStyles';
import { describeContributionError, describeGoalItemError } from '../../src/data/errors';
import {
  useContributions,
  useDeleteContribution,
  useGoal,
  type ContributionRead,
} from '../../src/data/goals';
import {
  useDeleteGoalItem,
  useGoalItems,
  useUpdateGoalItem,
  type GoalItemRead,
} from '../../src/data/goalItems';
import { flattenTree, type PlanRow } from '../../src/features/goals/plan/flattenTree';
import { ItemMoveSheet } from '../../src/features/goals/plan/ItemMoveSheet';
import { PlanNodeRow } from '../../src/features/goals/plan/PlanNodeRow';
import { PlanSummary } from '../../src/features/goals/plan/PlanSummary';
import { soonHorizon } from '../../src/features/goals/plan/soon';
import { useLang, useLocale, useT } from '../../src/i18n/context';

type Tab = 'plan' | 'saved';

export default function GoalPlanScreen() {
  const t = useT();
  const styles = useStyles();
  const params = useLocalSearchParams<{ id?: string }>();
  const goalId = params.id;

  if (goalId === undefined) {
    return (
      <Shell title={t('goalPlan.title')}>
        <View style={styles.stateBox}>
          <Text style={styles.notice}>{t('goalPlan.notFound')}</Text>
        </View>
      </Shell>
    );
  }

  return <GoalPlan goalId={goalId} />;
}

function GoalPlan({ goalId }: { goalId: string }) {
  const t = useT();
  const styles = useStyles();
  const lang = useLang();

  const goalQuery = useGoal(goalId);
  const itemsQuery = useGoalItems(goalId);
  const updateItem = useUpdateGoalItem(goalId);
  const deleteItem = useDeleteGoalItem(goalId);

  const [tab, setTab] = useState<Tab>('plan');
  // Genuine client state: which nodes the user folded away, and which one's
  // details are open. Ids, not nodes — a refetch replaces every object.
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(new Set());
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [moving, setMoving] = useState<GoalItemRead | null>(null);
  const [actionError, setActionError] = useState<string | undefined>(undefined);

  const goal = goalQuery.data;
  const list = itemsQuery.data;

  const tree = useMemo(() => (list ? buildTree(list.items) : undefined), [list]);
  const rows = useMemo(
    () => (tree ? flattenTree(tree.roots, collapsedIds) : []),
    [tree, collapsedIds],
  );

  // UTC, because the SERVER decided these dates in UTC: a local-midnight compare
  // marks the wrong rows for hours in any offset zone.
  const today = todayApiDateUtc();
  const soonUntil = useMemo(() => soonHorizon(today), [today]);

  const pending = updateItem.isPending || deleteItem.isPending;
  const readOnly = goal?.archived ?? false;

  const toggleCollapse = useCallback((item: GoalItemRead) => {
    setCollapsedIds((previous) => {
      const next = new Set(previous);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
  }, []);

  const toggleDetails = useCallback((item: GoalItemRead) => {
    setDetailsId((previous) => (previous === item.id ? null : item.id));
  }, []);

  const reorder = useCallback(
    (item: GoalItemRead, direction: 'up' | 'down') => {
      setActionError(undefined);
      // `move` is a RELATIVE instruction resolved by the server against the
      // current sibling order — the client never computes a `sort_order`.
      updateItem.mutate(
        { itemId: item.id, body: { move: direction } },
        { onError: (error) => setActionError(describeGoalItemError(error, lang).message) },
      );
    },
    [updateItem, lang],
  );

  /**
   * The delete confirm, assembled from sentences that are only said when TRUE.
   *
   * Two counts, two provenances, and neither counts the node being deleted: the
   * descendants are client structure (`descendantCount` over the built tree), the
   * files are the server's `subtree_files_count`. A leaf with no attachments gets
   * neither sentence instead of being told "1 plan item and 0 files" go with it.
   * Each clause is its own plural key so ru agreement works.
   */
  const deleteMessage = useCallback(
    (item: GoalItemRead, node: PlanNode | undefined) => {
      const children = node ? descendantCount(node) : 0;
      const files = item.subtree_files_count;
      return [
        t('goalPlan.deleteMessage', { name: item.name }),
        children > 0 ? t('goalPlan.deleteChildrenNote', { count: children }) : null,
        files > 0 ? t('goalPlan.deleteFilesNote', { count: files }) : null,
        t('goalPlan.deleteKeepsOperations'),
      ]
        .filter((sentence): sentence is string => sentence !== null)
        .join(' ');
    },
    [t],
  );

  const askDelete = useCallback(
    (item: GoalItemRead) => {
      setActionError(undefined);
      confirmAction({
        cancelLabel: t('common.cancel'),
        title: t('goalPlan.deleteTitle'),
        // No node in the tree means the row is no longer in the response: claim
        // nothing about what is inside it.
        message: deleteMessage(item, tree?.byId.get(item.id)),
        confirmLabel: t('common.delete'),
        destructive: true,
        onConfirm: () => {
          deleteItem.mutate(
            { itemId: item.id },
            {
              onSuccess: () => setDetailsId(null),
              onError: (error) =>
                setActionError(describeGoalItemError(error, lang).message),
            },
          );
        },
      });
    },
    [t, deleteMessage, tree, deleteItem, lang],
  );

  /**
   * Adding the FIRST item changes what the goal's cost MEANS (from the manual
   * target to a bottom-up sum), so the user is told BEFORE the form opens —
   * after the write they would be looking at a goal whose cost suddenly comes
   * from somewhere else, with no explanation.
   */
  const startCreate = useCallback(
    (parentId: string | null) => {
      setActionError(undefined);
      const open = () =>
        router.push({
          pathname: '/goal-item-form',
          params: parentId === null ? { goalId } : { goalId, parentId },
        });
      if (goal?.has_items === false) {
        confirmAction({
          cancelLabel: t('common.cancel'),
          title: t('goalPlan.firstItemTitle'),
          message: t('goalPlan.firstItemMessage'),
          confirmLabel: t('goalPlan.firstItemConfirm'),
          onConfirm: open,
        });
        return;
      }
      open();
    },
    [goal?.has_items, goalId, t],
  );

  const rowActions = useMemo(
    () => ({
      onToggleCollapse: toggleCollapse,
      onToggleDetails: toggleDetails,
      onAddChild: (item: GoalItemRead) => startCreate(item.id),
      onEdit: (item: GoalItemRead) =>
        router.push({ pathname: '/goal-item-form', params: { goalId, id: item.id } }),
      onMove: (item: GoalItemRead) => {
        setActionError(undefined);
        setMoving(item);
      },
      onReorder: reorder,
      onDelete: askDelete,
    }),
    [toggleCollapse, toggleDetails, startCreate, goalId, reorder, askDelete],
  );

  // The goal is gone (or was never this user's — the no-oracle 404 makes those
  // indistinguishable). Its own arm, not a blank screen.
  const notFound = goalQuery.isError || itemsQuery.isError;
  const loading = goalQuery.isPending || itemsQuery.isPending;

  const header = (
    <View style={styles.header}>
      {goal ? <PlanSummary goal={goal} onEditCost={readOnly ? undefined : () => router.push({ pathname: '/goal-cost-form', params: { id: goalId } })} /> : null}

      {readOnly ? <Text style={styles.notice}>{t('goalPlan.archivedBanner')}</Text> : null}

      <View style={styles.segment}>
        <SegmentButton
          label={t('goalPlan.itemsTitle')}
          selected={tab === 'plan'}
          onPress={() => setTab('plan')}
        />
        <SegmentButton
          label={t('goalPlan.savedTab')}
          selected={tab === 'saved'}
          onPress={() => setTab('saved')}
        />
      </View>

      {actionError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {actionError}
        </Text>
      ) : null}

      {tab === 'plan' && !readOnly ? (
        <FormButton label={t('goalPlan.addItem')} onPress={() => startCreate(null)} />
      ) : null}
      {tab === 'saved' && !readOnly ? (
        <FormButton
          label={t('goalPlan.addContribution')}
          onPress={() =>
            router.push({ pathname: '/contribution-form', params: { id: goalId } })
          }
        />
      ) : null}
    </View>
  );

  return (
    <Shell title={goal ? goal.name : t('goalPlan.title')}>
      {loading ? (
        <View style={styles.stateBox}>
          <View style={styles.skeletonSummary} />
          <View style={styles.skeletonRow} />
          <View style={styles.skeletonRow} />
        </View>
      ) : notFound ? (
        <EmptyState
          role="alert"
          title={t('goalPlan.loadFailed')}
          action={
            <View style={styles.stateActions}>
              <FormButton
                label={t('common.retry')}
                variant="secondary"
                onPress={() => {
                  void goalQuery.refetch();
                  void itemsQuery.refetch();
                }}
              />
              <FormButton
                label={t('goalPlan.backToGoals')}
                variant="secondary"
                onPress={() => router.back()}
              />
            </View>
          }
        />
      ) : tab === 'plan' ? (
        <FlatList<PlanRow>
          data={rows}
          keyExtractor={(row) => row.node.item.id}
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={header}
          renderItem={({ item: row }) => (
            <PlanNodeRow
              row={row}
              goalCurrency={list?.goal_currency ?? goal?.goal_currency ?? ''}
              readOnly={readOnly}
              pending={pending}
              detailsOpen={detailsId === row.node.item.id}
              today={today}
              soonUntil={soonUntil}
              actions={rowActions}
            />
          )}
          ListEmptyComponent={
            // No "the plan is incomplete" warning here: with no items the goal's
            // manual amount simply IS the goal's amount, exactly as before the
            // plan existed.
            <EmptyState
              title={t('goalPlan.emptyTitle')}
              description={t('goalPlan.emptyBody')}
            />
          }
        />
      ) : (
        <ContributionsTab goalId={goalId} currency={goal?.currency ?? ''} header={header} />
      )}

      {moving && list ? (
        <ItemMoveSheet
          item={moving}
          items={list.items}
          error={actionError}
          pending={updateItem.isPending}
          onPick={(parentId) => {
            setActionError(undefined);
            updateItem.mutate(
              { itemId: moving.id, body: { parent_id: parentId } },
              {
                onSuccess: () => setMoving(null),
                onError: (error) =>
                  setActionError(describeGoalItemError(error, lang).message),
              },
            );
          }}
          onClose={() => {
            setActionError(undefined);
            setMoving(null);
          }}
        />
      ) : null}
    </Shell>
  );
}

/**
 * The goal's ledger, newest first (the server's order). Rows are shown exactly as
 * stored: a withdrawal is a NEGATIVE amount and a future-dated contribution is an
 * ordinary row. Amounts decode with the GOAL's currency (AM-5).
 */
function ContributionsTab({
  goalId,
  currency,
  header,
}: {
  goalId: string;
  currency: string;
  header: React.ReactElement;
}) {
  const t = useT();
  const styles = useStyles();
  const lang = useLang();
  const locale = useLocale();
  const contributions = useContributions(goalId);
  const deleteContribution = useDeleteContribution(goalId);
  const [error, setError] = useState<string | undefined>(undefined);

  const items = useMemo(
    () => contributions.data?.pages.flatMap((page) => page.items) ?? [],
    [contributions.data],
  );

  const askDelete = (row: ContributionRead) => {
    setError(undefined);
    confirmAction({
      cancelLabel: t('common.cancel'),
      title: t('contributionList.deleteTitle'),
      message: t('contributionList.deleteMessage'),
      confirmLabel: t('common.delete'),
      destructive: true,
      onConfirm: () => {
        deleteContribution.mutate(
          { contributionId: row.id },
          {
            // Includes CONTRIBUTION_EXCEEDS_SAVED: deleting a positive row is a
            // withdrawal in disguise, and the server refuses if it would go
            // below zero.
            onError: (caught) =>
              setError(describeContributionError(caught, lang).message),
          },
        );
      },
    });
  };

  return (
    <FlatList<ContributionRead>
      data={items}
      keyExtractor={(row) => row.id}
      contentContainerStyle={styles.listContent}
      ListHeaderComponent={
        <>
          {header}
          {error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          ) : null}
          {contributions.isError ? (
            <EmptyState
              role="alert"
              title={t('contributionList.loadFailed')}
              action={
                <FormButton
                  label={t('common.retry')}
                  variant="secondary"
                  onPress={() => contributions.refetch()}
                />
              }
            />
          ) : null}
        </>
      }
      renderItem={({ item }) => (
        <View style={styles.contribution}>
          <View style={styles.contributionText}>
            <Text style={styles.contributionDate}>
              {formatApiDate(item.occurred_at, { locale })}
            </Text>
            {item.note ? (
              <Text style={styles.notice} numberOfLines={2}>
                {item.note}
              </Text>
            ) : null}
          </View>
          {/* Coloured by KIND: money going IN is income, a withdrawal is money
              coming back out. */}
          <Text
            style={[
              styles.contributionAmount,
              item.amount_minor < 0 ? styles.withdrawal : styles.contributionIn,
            ]}
          >
            {formatMoney(item.amount_minor, currency, { locale })}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('common.delete')}
            accessibilityState={{ disabled: deleteContribution.isPending }}
            disabled={deleteContribution.isPending}
            onPress={() => askDelete(item)}
            style={styles.contributionDelete}
          >
            <Text style={styles.contributionDeleteText}>{t('common.delete')}</Text>
          </Pressable>
        </View>
      )}
      ListEmptyComponent={
        contributions.isPending || contributions.isError ? null : (
          <Text style={styles.notice}>{t('contributionList.empty')}</Text>
        )
      }
      // The server caps a page at 200; beyond that the next page is fetched as
      // the user reaches the end, exactly like the transactions list.
      onEndReachedThreshold={0.5}
      onEndReached={() => {
        if (contributions.hasNextPage && !contributions.isFetchingNextPage) {
          void contributions.fetchNextPage();
        }
      }}
    />
  );
}

function SegmentButton({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const styles = useStyles();
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.segmentButton, selected && styles.segmentButtonSelected]}
    >
      <Text style={[styles.segmentText, selected && styles.segmentTextSelected]}>
        {label}
      </Text>
    </Pressable>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  const t = useT();
  const styles = useStyles();
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.screenHeader}>
        <Pressable accessibilityRole="button" onPress={() => router.back()} hitSlop={8}>
          <Text style={styles.back}>{t('goalPlan.backToGoals')}</Text>
        </Pressable>
      </View>
      {/* The goal's NAME is user-typed and never translated. */}
      <Text style={styles.screenTitle} numberOfLines={2}>
        {title}
      </Text>
      {children}
    </SafeAreaView>
  );
}

const useStyles = themedStyles((t) => ({
  safe: {
    flex: 1,
    backgroundColor: t.colors.bg,
  },
  screenHeader: {
    paddingHorizontal: t.spacing.lg,
    paddingTop: t.spacing.sm,
    minHeight: t.TOUCH_TARGET,
    justifyContent: 'center',
  },
  back: {
    fontSize: t.type.md,
    color: t.colors.accent,
  },
  screenTitle: {
    paddingHorizontal: t.spacing.lg,
    paddingBottom: t.spacing.sm,
    fontSize: t.type.xl,
    fontWeight: '700',
    color: t.colors.text,
  },
  listContent: {
    padding: t.spacing.lg,
    paddingTop: 0,
    gap: t.spacing.sm,
  },
  header: {
    gap: t.spacing.sm,
    marginBottom: t.spacing.sm,
  },
  segment: {
    flexDirection: 'row',
    gap: t.spacing.sm,
  },
  segmentButton: {
    flex: 1,
    minHeight: t.TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: t.radius.md,
    borderWidth: 1,
    borderColor: t.colors.border,
    backgroundColor: t.colors.surface,
  },
  // The one selected-state recipe this app has: soft fill plus an ACCENT BORDER,
  // which is what carries the state on a phone (no hover, no focus ring).
  segmentButtonSelected: t.selected.chip,
  segmentText: {
    fontSize: t.type.sm,
    color: t.colors.text,
    fontWeight: '600',
  },
  segmentTextSelected: t.selected.text,
  stateBox: {
    padding: t.spacing.lg,
    gap: t.spacing.md,
  },
  stateActions: {
    gap: t.spacing.sm,
    alignSelf: 'stretch',
  },
  skeletonSummary: {
    height: 180,
    borderRadius: t.radius.lg,
    backgroundColor: t.colors.surfaceMuted,
  },
  skeletonRow: {
    height: 64,
    borderRadius: t.radius.md,
    backgroundColor: t.colors.surfaceMuted,
  },
  notice: {
    fontSize: t.type.sm,
    color: t.colors.textMuted,
  },
  error: {
    fontSize: t.type.sm,
    color: t.colors.danger,
  },
  contribution: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.sm,
    backgroundColor: t.colors.surface,
    borderRadius: t.radius.md,
    borderWidth: 1,
    borderColor: t.colors.border,
    paddingHorizontal: t.spacing.md,
    paddingVertical: t.spacing.sm,
    minHeight: t.TOUCH_TARGET,
  },
  contributionText: {
    flex: 1,
    gap: 2,
  },
  contributionDate: {
    fontSize: t.type.sm,
    color: t.colors.text,
  },
  contributionAmount: {
    fontSize: t.type.md,
    fontWeight: '600',
    color: t.colors.text,
    ...t.tnum,
  },
  withdrawal: {
    color: t.colors.expense,
  },
  contributionIn: {
    color: t.colors.income,
  },
  contributionDelete: {
    minHeight: t.TOUCH_TARGET,
    justifyContent: 'center',
    paddingHorizontal: t.spacing.xs,
  },
  contributionDeleteText: {
    fontSize: t.type.sm,
    color: t.colors.danger,
    fontWeight: '600',
  },
}));
