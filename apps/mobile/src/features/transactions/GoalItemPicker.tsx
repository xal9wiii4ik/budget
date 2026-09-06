// "Which plan item does this pay for?" — the transaction form's attach control
// (mobile-catchup-3, line C), the port of web's GoalItemPicker.
//
// TWO steps rather than one flat list: a user with five goals of forty nodes each
// would otherwise scroll two hundred chips, and the item request is per goal
// anyway (`GET /goals/{goal_id}/items`, one tree per call) — so the goal choice
// IS what makes the second request legal. Nothing here is sent but
// `goal_item_id`; the goal is UI state that decides which tree to fetch.
//
// The field NEVER touches the amount: attaching an operation does not convert it,
// split it or move it. `paid` on the node is a server rollup over these rows, and
// this client adds no money anywhere.
//
// Folded away by default, like the country field: an attachment is a detail of a
// minority of rows and must not crowd a form whose main job is an amount.
import {
  goalItemOptions,
  NO_GOAL_ITEM,
  type GoalItemSelection,
} from '@budget/api-client';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, spacing, TOUCH_TARGET } from '../../components/theme';
import { goalItemsQueryOptions, type GoalItemList } from '../../data/goalItems';
import { useGoals } from '../../data/goals';
import { qk } from '../../data/queryKeys';
import { useT } from '../../i18n/context';

/**
 * Which goal owns an item id.
 *
 * The wire gives the edit form `goal_item_id` and nothing else —
 * `TransactionRead` carries no `goal_id` — so the goal has to be found before the
 * two steps can show the attachment the row actually has. Two steps, cheapest
 * first:
 *   1. the query CACHE: coming from the plan screen (or after a previous open of
 *      this form) the tree is already there, and the answer costs no request;
 *   2. a fan-out over the non-archived goals' trees. There are single digits of
 *      them, each response is cached under the very key this picker uses, and it
 *      runs ONLY in edit mode with an attachment present.
 *
 * `missing` is a real answer, not a failure: the item may belong to an ARCHIVED
 * goal (not in the list) or have been deleted elsewhere. The caller says so and
 * KEEPS the link — silently dropping an attachment on save would be a data loss
 * the user never asked for.
 */
type GoalOfItem =
  | { status: 'idle' }
  | { status: 'resolving' }
  | { status: 'found'; goalId: string }
  | { status: 'missing' };

function findGoalId(
  lists: readonly (GoalItemList | undefined)[],
  itemId: string,
): string | null {
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
  // accessor. No subscription and no request.
  const cached =
    itemId === null
      ? null
      : findGoalId(
          goalIds.map((goalId) => queryClient.getQueryData<GoalItemList>(qk.goalItems(goalId))),
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
  /** A server code routed here (GOAL_ITEM_NOT_FOUND / GOAL_ARCHIVED). */
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
  // Open when the row ARRIVED attached, or when a 422 about it needs reading:
  // a folded section holding a live value (or an error) would hide the thing the
  // user has to act on.
  const [open, setOpen] = useState(initialItemId !== null);

  // Non-archived goals only: an archived goal takes no new writes (422
  // GOAL_ARCHIVED), so offering one would be offering a guaranteed refusal.
  const goalsQuery = useGoals(false);
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
    value.goalId !== '' ? value.goalId : resolved.status === 'found' ? resolved.goalId : '';

  const itemsQuery = useQuery({ ...goalItemsQueryOptions(goalId), enabled: goalId !== '' });
  const options = goalItemOptions(itemsQuery.data?.items ?? []);

  const showError = errorMessage !== undefined;

  return (
    <View style={styles.field}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open || showError }}
        onPress={() => setOpen((previous) => !previous)}
        style={styles.toggle}
      >
        <Text style={styles.label}>
          {t('txForm.goalItem')} <Text style={styles.hint}>{t('common.optional')}</Text>
        </Text>
        <Text style={styles.chevron}>{open || showError ? '▾' : '▸'}</Text>
      </Pressable>

      {open || showError ? (
        <>
          {/* Still working out which goal the stored item belongs to. The control
              would otherwise show "no goal" — a lie about a row that IS attached. */}
          {resolved.status === 'resolving' ? (
            <Text style={styles.hint}>{t('txForm.goalItemResolving')}</Text>
          ) : null}

          <View style={styles.chips}>
            <Chip
              label={t('txForm.goalItemNone')}
              selected={goalId === ''}
              disabled={disabled}
              // Changing the goal drops the item: an id from another goal's tree
              // is a guaranteed 404, and keeping it hidden in state is how a form
              // ends up submitting something the user cannot see.
              onPress={() => onChange(NO_GOAL_ITEM)}
            />
            {goals.map((goal) => (
              <Chip
                key={goal.id}
                // The goal's NAME is user text: never translated.
                label={goal.name}
                selected={goalId === goal.id}
                disabled={disabled}
                onPress={() => onChange({ goalId: goal.id, itemId: '' })}
              />
            ))}
          </View>

          {goalsQuery.isError ? (
            <Text style={styles.hint}>{t('txForm.goalItemGoalsFailed')}</Text>
          ) : null}

          {goalId !== '' ? (
            <>
              <Text style={styles.label}>{t('txForm.goalItemNode')}</Text>
              <View style={styles.chips}>
                <Chip
                  label={t('txForm.goalItemNoNode')}
                  selected={value.itemId === ''}
                  disabled={disabled}
                  onPress={() => onChange({ goalId, itemId: '' })}
                />
                {options.map((option) => (
                  <Chip
                    key={option.id}
                    // Dashes carry the LEVEL: a flat chip row cannot nest, and
                    // the server's `depth` is what says how deep the node sits.
                    label={`${'— '.repeat(option.depth - 1)}${option.name}`}
                    selected={value.itemId === option.id}
                    disabled={disabled}
                    onPress={() => onChange({ goalId, itemId: option.id })}
                  />
                ))}
              </View>
              {itemsQuery.isPending ? (
                <Text style={styles.hint}>{t('common.loading')}</Text>
              ) : null}
              {itemsQuery.isError ? (
                <Text style={styles.hint}>{t('txForm.goalItemNodesFailed')}</Text>
              ) : null}
              {!itemsQuery.isPending && !itemsQuery.isError && options.length === 0 ? (
                <Text style={styles.hint}>{t('txForm.goalItemEmptyPlan')}</Text>
              ) : null}
            </>
          ) : null}

          {/* The attachment exists but its goal is not among the live ones — most
              likely archived. Named rather than silently dropped: the link stays
              on the row unless the user detaches it here. */}
          {resolved.status === 'missing' ? (
            <View style={styles.unknown}>
              <Text style={styles.hint}>{t('txForm.goalItemUnknown')}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled }}
                disabled={disabled}
                onPress={() => onChange(NO_GOAL_ITEM)}
                style={styles.detach}
              >
                <Text style={styles.detachText}>{t('txForm.goalItemDetach')}</Text>
              </Pressable>
            </View>
          ) : null}

          {errorMessage ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {errorMessage}
            </Text>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

function Chip({
  label,
  selected,
  disabled,
  onPress,
}: {
  label: string;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.chip, selected && styles.chipSelected]}
    >
      <Text style={[styles.chipText, selected && styles.chipTextSelected]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  field: {
    gap: spacing.xs,
  },
  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: TOUCH_TARGET,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
  },
  chevron: {
    fontSize: 14,
    color: colors.textMuted,
  },
  hint: {
    fontSize: 12,
    fontWeight: '400',
    color: colors.textMuted,
  },
  error: {
    fontSize: 13,
    color: colors.danger,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  chip: {
    maxWidth: '100%',
    minHeight: TOUCH_TARGET - 8,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    justifyContent: 'center',
  },
  chipSelected: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  chipText: {
    fontSize: 14,
    color: colors.text,
  },
  chipTextSelected: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  unknown: {
    gap: spacing.xs,
  },
  detach: {
    minHeight: TOUCH_TARGET,
    justifyContent: 'center',
  },
  detachText: {
    fontSize: 14,
    color: colors.primary,
    fontWeight: '600',
  },
});
