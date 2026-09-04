import { useState } from 'react';
import { Link, useParams } from 'react-router';

import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EmptyState } from '../components/EmptyState';
import { QueryStateNotice } from '../components/QueryStateNotice';
import { useGoal } from '../data/goals';
import {
  useDeleteGoalItem,
  useGoalItems,
  useUpdateGoalItem,
  type GoalItemRead,
} from '../data/goalItems';
import { FinalCostSection } from '../features/goals/plan/FinalCostSection';
import { GoalItemFormModal } from '../features/goals/plan/GoalItemFormModal';
import { ItemMoveDialog } from '../features/goals/plan/ItemMoveDialog';
import { PlanSummary } from '../features/goals/plan/PlanSummary';
import { PlanTree } from '../features/goals/plan/PlanTree';
import { buildTree, descendantCount, type PlanNode } from '../features/goals/plan/buildTree';
import { useLang, useT } from '../i18n/context';
import type { Translate } from '../i18n/t';
import { ApiError } from '../lib/query';
import { describeGoalItemError } from '../lib/errors';
import { queryPhase, type QueryPhase } from '../lib/queryPhase';
import styles from './GoalPlanPage.module.css';

type PlanModal =
  | { type: 'closed' }
  // The transition warning, shown BEFORE the form of the FIRST item: after the
  // write the user would be looking at a goal whose cost suddenly comes from
  // somewhere else, with no explanation (task.md).
  | { type: 'confirm-first'; parentId: string | null }
  | { type: 'create'; parentId: string | null }
  | { type: 'edit'; item: GoalItemRead }
  | { type: 'move'; item: GoalItemRead }
  | { type: 'delete'; item: GoalItemRead };

/**
 * The delete confirmation, assembled from sentences that are only said when they
 * are TRUE (qa F-2).
 *
 * Two counts, two provenances, and neither of them counts the node being
 * deleted: the descendants are client structure (`descendantCount` over the
 * built tree), the files are the server's `subtree_files_count`. A leaf with no
 * attachments therefore gets neither sentence, instead of being told that "1
 * plan item and 0 attached files" go with it. Plural forms carry the agreement
 * (ru "уйдёт" vs "уйдут"), which is why each clause is its own key.
 */
function deleteMessage(
  item: GoalItemRead,
  node: PlanNode | undefined,
  t: Translate,
): string {
  // No node in the tree means the row the dialog was opened from is no longer in
  // the response: claim nothing about what is inside it.
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
}

/** The worst of the two reads: one screen, one honest phase. */
function combinePhase(a: QueryPhase, b: QueryPhase): QueryPhase {
  if (a === 'error' || b === 'error') return 'error';
  if (a === 'unreachable' || b === 'unreachable') return 'unreachable';
  if (a === 'loading' || b === 'loading') return 'loading';
  return 'ready';
}

export function GoalPlanPage() {
  const { goalId } = useParams();
  const t = useT();

  if (goalId === undefined) {
    return (
      <section className={styles.page}>
        <p className={styles.missing}>{t('goalPlan.notFound')}</p>
        <Link className={styles.backLink} to="/goals">
          {t('goalPlan.backToGoals')}
        </Link>
      </section>
    );
  }

  return <GoalPlan goalId={goalId} />;
}

/**
 * One goal as a PLAN: the cost block, the three progress figures and the tree.
 *
 * Both reads are per-goal and single: `GET /goals/{id}` (Q6 — the plan fields
 * come from the single response, never from a cached list that a deep link would
 * not have) and `GET /goals/{id}/items`, which returns the WHOLE tree in one
 * request. There is no per-node query, by design.
 *
 * Every number is a server field. The only thing derived here is the SHAPE of the
 * tree (`buildTree`) and the size of a subtree for the delete dialog's copy.
 */
function GoalPlan({ goalId }: { goalId: string }) {
  const t = useT();
  const lang = useLang();
  const [modal, setModal] = useState<PlanModal>({ type: 'closed' });
  const [actionError, setActionError] = useState<string | undefined>(undefined);

  const goalQuery = useGoal(goalId);
  const itemsQuery = useGoalItems(goalId);
  const updateItem = useUpdateGoalItem(goalId);
  const deleteItem = useDeleteGoalItem(goalId);

  const phase = combinePhase(queryPhase(goalQuery), queryPhase(itemsQuery));
  const goal = goalQuery.data;
  const list = itemsQuery.data;

  // The goal is gone (or was never this user's — the no-oracle 404 makes those
  // indistinguishable, and by the time this screen sees it the honest reading is
  // the same). Its own arm, not a blank screen.
  const notFound =
    goalQuery.error instanceof ApiError && goalQuery.error.status === 404
      ? true
      : itemsQuery.error instanceof ApiError && itemsQuery.error.status === 404;

  const tree = list ? buildTree(list.items) : undefined;
  const pending = updateItem.isPending || deleteItem.isPending;

  const reorder = async (item: GoalItemRead, direction: 'up' | 'down') => {
    setActionError(undefined);
    try {
      await updateItem.mutateAsync({ itemId: item.id, body: { move: direction } });
    } catch (error) {
      setActionError(describeGoalItemError(error, lang).message);
    }
  };

  const confirmDelete = async (item: GoalItemRead) => {
    setActionError(undefined);
    try {
      await deleteItem.mutateAsync({ itemId: item.id });
      setModal({ type: 'closed' });
    } catch (error) {
      setActionError(describeGoalItemError(error, lang).message);
    }
  };

  const startCreate = (parentId: string | null) => {
    setActionError(undefined);
    setModal(
      goal?.has_items === false
        ? { type: 'confirm-first', parentId }
        : { type: 'create', parentId },
    );
  };

  const deleteNode = modal.type === 'delete' ? tree?.byId.get(modal.item.id) : undefined;

  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.backLink} to="/goals">
          {t('goalPlan.backToGoals')}
        </Link>
        {/* The goal's NAME is user-typed and never translated. */}
        <h1 className={styles.title}>{goal ? goal.name : t('goalPlan.title')}</h1>
        {goal?.archived ? <Badge>{t('common.archivedTag')}</Badge> : null}
      </header>

      {notFound ? (
        <EmptyState
          title={t('goalPlan.notFound')}
          actions={
            <Link className={styles.backLink} to="/goals">
              {t('goalPlan.backToGoals')}
            </Link>
          }
        />
      ) : phase === 'loading' ? (
        <div className={styles.skeletons} aria-hidden="true">
          <div className={styles.skeletonSummary} />
          <div className={styles.skeletonRow} />
          <div className={styles.skeletonRow} />
          <div className={styles.skeletonRow} />
        </div>
      ) : phase === 'error' || phase === 'unreachable' ? (
        <QueryStateNotice
          phase={phase}
          message={t('goalPlan.loadFailed')}
          onRetry={() => {
            void goalQuery.refetch();
            void itemsQuery.refetch();
          }}
        />
      ) : goal && list && tree ? (
        <>
          {goal.archived ? (
            <p className={styles.archivedBanner} role="status">
              {t('goalPlan.archivedBanner')}
            </p>
          ) : null}

          <PlanSummary goal={goal} />
          <FinalCostSection goal={goal} />

          {actionError ? (
            <p className={styles.actionError} role="alert">
              {actionError}
            </p>
          ) : null}

          <section className={styles.treeSection}>
            <header className={styles.treeHeader}>
              <h2 className={styles.treeTitle}>{t('goalPlan.itemsTitle')}</h2>
              {goal.archived ? null : (
                <Button variant="primary" onClick={() => startCreate(null)} disabled={pending}>
                  {t('goalPlan.addItem')}
                </Button>
              )}
            </header>

            {list.items.length === 0 ? (
              <EmptyState
                title={t('goalPlan.emptyTitle')}
                // No "the plan is incomplete" warning here: with no items the
                // goal's manual amount is simply the goal's amount, exactly as
                // before the plan existed.
                description={t('goalPlan.emptyBody')}
                actions={
                  goal.archived ? undefined : (
                    <Button variant="primary" onClick={() => startCreate(null)}>
                      {t('goalPlan.addItem')}
                    </Button>
                  )
                }
              />
            ) : (
              <PlanTree
                roots={tree.roots}
                goalCurrency={list.goal_currency}
                readOnly={goal.archived}
                pending={pending}
                actions={{
                  onAddChild: (parent) => startCreate(parent.id),
                  onEdit: (item) => {
                    setActionError(undefined);
                    setModal({ type: 'edit', item });
                  },
                  onMove: (item) => {
                    setActionError(undefined);
                    setModal({ type: 'move', item });
                  },
                  onDelete: (item) => {
                    setActionError(undefined);
                    setModal({ type: 'delete', item });
                  },
                  onReorder: (item, direction) => void reorder(item, direction),
                }}
              />
            )}
          </section>
        </>
      ) : null}

      {modal.type === 'confirm-first' && goal ? (
        <ConfirmDialog
          title={t('goalPlan.firstItemTitle')}
          message={t('goalPlan.firstItemMessage')}
          confirmLabel={t('goalPlan.firstItemConfirm')}
          onConfirm={() => setModal({ type: 'create', parentId: modal.parentId })}
          onCancel={() => setModal({ type: 'closed' })}
        />
      ) : null}

      {modal.type === 'create' && goal && list ? (
        <GoalItemFormModal
          goalId={goalId}
          goalCurrency={list.goal_currency}
          parentId={modal.parentId}
          // A new node inherits its parent's effective deadline, else the goal's.
          inheritedDeadline={
            (modal.parentId === null
              ? goal.deadline
              : (tree?.byId.get(modal.parentId)?.item.effective_deadline ?? goal.deadline)) ??
            null
          }
          onClose={() => setModal({ type: 'closed' })}
        />
      ) : null}

      {modal.type === 'edit' && goal && list ? (
        <GoalItemFormModal
          key={modal.item.id}
          goalId={goalId}
          goalCurrency={list.goal_currency}
          item={modal.item}
          // What this node's date resolves to WITHOUT its own: its parent's
          // effective date, else the goal's. Never the node's own effective date
          // — that would count the value being edited.
          inheritedDeadline={
            (modal.item.parent_id === null
              ? goal.deadline
              : (tree?.byId.get(modal.item.parent_id)?.item.effective_deadline ??
                goal.deadline)) ?? null
          }
          onClose={() => setModal({ type: 'closed' })}
        />
      ) : null}

      {modal.type === 'move' && list ? (
        <ItemMoveDialog
          goalId={goalId}
          item={modal.item}
          items={list.items}
          onClose={() => setModal({ type: 'closed' })}
        />
      ) : null}

      {modal.type === 'delete' ? (
        <ConfirmDialog
          title={t('goalPlan.deleteTitle')}
          message={deleteMessage(modal.item, deleteNode, t)}
          confirmLabel={t('common.delete')}
          pendingLabel={t('common.deleting')}
          destructive
          isPending={deleteItem.isPending}
          errorMessage={actionError}
          onConfirm={() => void confirmDelete(modal.item)}
          onCancel={() => setModal({ type: 'closed' })}
        />
      ) : null}
    </section>
  );
}
