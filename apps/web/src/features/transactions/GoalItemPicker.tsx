// "Which plan item does this pay for?" — the transaction form's attach control
// (goal-planner W2). Named *Picker, not *Field, because the case-insensitive
// filesystems this repo is developed on cannot hold both this and the pure
// `goalItemField.ts` beside it.
//
// TWO selects rather than one grouped list: a user with five goals of forty nodes
// each would otherwise scroll a two-hundred-line dropdown, and the item request is
// per goal anyway (`GET /goals/{goal_id}/items`, one tree per call) — so the goal
// choice IS what makes the second request legal. Nothing here is sent but
// `goal_item_id`; the goal is UI state that decides which tree to fetch.
//
// The field NEVER touches the amount: attaching an operation does not convert it,
// split it or move it. `paid` on the node is a server rollup over these rows
// (architecture §4), and this client adds no money anywhere.
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';

import { goalItemsQueryOptions, type GoalItemList } from '../../data/goalItems';
import { useGoals } from '../../data/goals';
import { qk } from '../../data/queryKeys';
import { useT } from '../../i18n/context';
import { queryPhase } from '../../lib/queryPhase';
import { goalItemOptions, NO_GOAL_ITEM, type GoalItemSelection } from './goalItemField';
import styles from './TransactionFormModal.module.css';

/**
 * Which goal owns an item id.
 *
 * The wire gives the edit form `goal_item_id` and nothing else — `TransactionRead`
 * carries no `goal_id` — so the goal has to be found before the two selects can
 * show the attachment the row actually has. Two steps, cheapest first:
 *
 *   1. the query CACHE: coming from the plan screen (or after a previous open of
 *      this form) the tree is already there, and the answer costs no request;
 *   2. a fan-out over the non-archived goals' trees. There are single digits of
 *      them, each response is cached under the very key the picker uses, and it
 *      runs ONLY in edit mode with an attachment present.
 *
 * `missing` is a real answer, not a failure: the item may belong to an ARCHIVED
 * goal (not in the list) or have been deleted in another tab. The caller says so
 * and keeps the link — silently dropping an attachment on save would be a data
 * loss the user never asked for.
 */
type GoalOfItem =
  | { status: 'idle' }
  | { status: 'resolving' }
  | { status: 'found'; goalId: string }
  | { status: 'missing' };

function findGoalId(lists: readonly (GoalItemList | undefined)[], itemId: string): string | null {
  for (const list of lists) {
    for (const item of list?.items ?? []) {
      if (item.id === itemId) return item.goal_id;
    }
  }
  return null;
}

function useGoalOfItem(itemId: string | null, goalIds: readonly string[]): GoalOfItem {
  const queryClient = useQueryClient();

  // Step 1 — what is ALREADY cached, read synchronously through the typed
  // accessor (the `useUpdateProfile` precedent). No subscription and no request:
  // arriving from the plan screen, or reopening this form, answers for free.
  const cached =
    itemId === null
      ? null
      : findGoalId(
          goalIds.map((goalId) =>
            queryClient.getQueryData<GoalItemList>(qk.goalItems(goalId)),
          ),
          itemId,
        );

  const needsFanOut = itemId !== null && cached === null;
  const results = useQueries({
    queries: needsFanOut ? goalIds.map((goalId) => goalItemsQueryOptions(goalId)) : [],
  });

  if (itemId === null) return { status: 'idle' };
  if (cached !== null) return { status: 'found', goalId: cached };
  const found = findGoalId(
    results.map((result) => result.data),
    itemId,
  );
  if (found !== null) return { status: 'found', goalId: found };
  // "Still loading" includes "the goal list has not arrived yet", which is what
  // an empty fan-out means while `useGoals` is pending.
  if (results.length === 0 || results.some((result) => result.isPending)) {
    return { status: 'resolving' };
  }
  return { status: 'missing' };
}

interface GoalItemPickerProps {
  value: GoalItemSelection;
  onChange: (next: GoalItemSelection) => void;
  /**
   * The attachment the EDITED row arrived with, or `null` in create mode. It is
   * what the goal is resolved from, and the resolution stops applying the moment
   * the user picks something else.
   */
  initialItemId: string | null;
  disabled: boolean;
  /** A server code routed here (GOAL_ITEM_NOT_FOUND / GOAL_ITEM_EXPENSE_ONLY). */
  errorMessage?: string;
}

export function GoalItemPicker({
  value,
  onChange,
  initialItemId,
  disabled,
  errorMessage,
}: GoalItemPickerProps) {
  const t = useT();

  // Non-archived goals only: an archived goal takes no new writes (422
  // GOAL_ARCHIVED), so offering one would be offering a guaranteed refusal.
  const goalsQuery = useGoals(false);
  const goalsPhase = queryPhase(goalsQuery);
  const goals = goalsQuery.data?.items ?? [];

  // Resolve the goal only while the form still holds the attachment it opened
  // with. Once the user picks another item (or clears it), `value.goalId` is
  // theirs and the resolution has nothing to say.
  const resolveFor =
    initialItemId !== null && value.itemId === initialItemId ? initialItemId : null;
  const resolved = useGoalOfItem(
    resolveFor,
    goals.map((goal) => goal.id),
  );

  // Derived during render, never copied into state: the goal the user picked, or
  // the one the attachment resolved to.
  const goalId =
    value.goalId !== ''
      ? value.goalId
      : resolved.status === 'found'
        ? resolved.goalId
        : '';

  const itemsQuery = useQuery({
    ...goalItemsQueryOptions(goalId),
    enabled: goalId !== '',
  });
  const itemsPhase = queryPhase(itemsQuery);
  const options = goalItemOptions(itemsQuery.data?.items ?? []);

  const onGoalChange = (nextGoalId: string) => {
    // Changing the goal drops the item: an id from another goal's tree is a
    // guaranteed 404 GOAL_ITEM_NOT_FOUND, and keeping it hidden in state is how a
    // form ends up submitting something the user cannot see.
    onChange(nextGoalId === '' ? NO_GOAL_ITEM : { goalId: nextGoalId, itemId: '' });
  };

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor="tx-goal">
        {t('txForm.goalItem')} <span className={styles.hint}>{t('common.optional')}</span>
      </label>

      {/* Still working out which goal the stored item belongs to. The control
          would otherwise show "no goal" — a lie about a row that IS attached. */}
      {resolved.status === 'resolving' ? (
        <p className={styles.hint} role="status">
          {t('txForm.goalItemResolving')}
        </p>
      ) : null}

      <select
        id="tx-goal"
        className={styles.select}
        value={goalId}
        disabled={disabled || goalsPhase !== 'ready'}
        onChange={(event) => onGoalChange(event.target.value)}
      >
        <option value="">{t('txForm.goalItemNone')}</option>
        {goals.map((goal) => (
          <option key={goal.id} value={goal.id}>
            {goal.name}
          </option>
        ))}
      </select>

      {goalsPhase === 'error' || goalsPhase === 'unreachable' ? (
        <p className={styles.hint} role="status">
          {t('txForm.goalItemGoalsFailed')}
        </p>
      ) : null}

      {goalId !== '' ? (
        <>
          <label className={`${styles.label} ${styles.stackedSelect}`} htmlFor="tx-goal-item">
            {t('txForm.goalItemNode')}
          </label>
          <select
            id="tx-goal-item"
            className={styles.select}
            value={value.itemId}
            disabled={disabled || itemsPhase !== 'ready'}
            onChange={(event) => onChange({ goalId, itemId: event.target.value })}
          >
            <option value="">{t('txForm.goalItemNoNode')}</option>
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {/* Dashes, not padding: a leading space in an <option> is
                    trimmed by some browsers (the ItemMoveDialog convention). */}
                {'— '.repeat(option.depth - 1)}
                {option.name}
              </option>
            ))}
          </select>
          {itemsPhase === 'loading' ? (
            <p className={styles.hint} role="status">
              {t('common.loading')}
            </p>
          ) : null}
          {itemsPhase === 'error' || itemsPhase === 'unreachable' ? (
            <p className={styles.hint} role="status">
              {t('txForm.goalItemNodesFailed')}
            </p>
          ) : null}
          {itemsPhase === 'ready' && options.length === 0 ? (
            <p className={styles.hint}>{t('txForm.goalItemEmptyPlan')}</p>
          ) : null}
        </>
      ) : null}

      {/* The attachment exists but its goal is not among the live ones — most
          likely archived. Named rather than silently dropped: the link stays on
          the row unless the user detaches it here. */}
      {resolved.status === 'missing' ? (
        <p className={styles.hint} role="status">
          {t('txForm.goalItemUnknown')}{' '}
          <button
            type="button"
            className={styles.linkButton}
            disabled={disabled}
            onClick={() => onChange(NO_GOAL_ITEM)}
          >
            {t('txForm.goalItemDetach')}
          </button>
        </p>
      ) : null}

      {errorMessage ? (
        <p className={styles.fieldError} role="alert">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
