// One node of the plan (memoized for the virtualized list) — the mobile port of
// web's PlanNodeRow + PlanNodeDetails.
//
// THREE currencies can meet on this row and each number is formatted with ITS
// OWN, never a fallback (AM-5):
//   `amount_minor`      — the item's own currency (`item.currency`);
//   `converted_minor`   — its paired `converted_currency`;
//   `children_sum_minor` / `paid_minor` — the GOAL's currency, echoed once by the
//                         tree response.
//
// `ceiling_exceeded` is a server FIELD, not an error: the row warns, naming both
// figures, and nothing is ever blocked because of it (the node's own amount is a
// guideline and a ceiling; the working number comes from below).
//
// The indent is the SERVER's `depth`. The row's actions live inside the expanded
// details rather than on the row itself: six ≥44pt targets do not fit across a
// phone, and the details panel is where the node is being worked on anyway.
import { formatApiDate, formatMoney } from '@budget/shared';
import { MAX_PLAN_DEPTH } from '@budget/api-client';
import { memo } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, spacing, TOUCH_TARGET } from '../../../components/theme';
import type { GoalItemRead } from '../../../data/goalItems';
import { useLocale, useT } from '../../../i18n/context';
import { ItemPhotos } from './ItemPhotos';
import { isSoon } from './soon';
import type { PlanRow } from './flattenTree';

export interface PlanRowActions {
  onToggleCollapse: (item: GoalItemRead) => void;
  onToggleDetails: (item: GoalItemRead) => void;
  onAddChild: (item: GoalItemRead) => void;
  onEdit: (item: GoalItemRead) => void;
  onMove: (item: GoalItemRead) => void;
  onReorder: (item: GoalItemRead, direction: 'up' | 'down') => void;
  onDelete: (item: GoalItemRead) => void;
}

interface PlanNodeRowProps {
  row: PlanRow;
  goalCurrency: string;
  /** Archived goal: readable, nothing on it writable. */
  readOnly: boolean;
  /** A write is in flight somewhere on the screen. */
  pending: boolean;
  detailsOpen: boolean;
  /** Today, UTC ("YYYY-MM-DD") — and the last date still counted as "soon". */
  today: string;
  soonUntil: string;
  actions: PlanRowActions;
}

const INDENT_PER_LEVEL = 14;

function PlanNodeRowImpl({
  row,
  goalCurrency,
  readOnly,
  pending,
  detailsOpen,
  today,
  soonUntil,
  actions,
}: PlanNodeRowProps) {
  const t = useT();
  const locale = useLocale();
  const item = row.node.item;

  const ownAmount =
    item.amount_minor === null
      ? null
      : formatMoney(item.amount_minor, item.currency, { locale });
  const converted =
    item.converted_minor !== null && item.converted_currency !== null
      ? formatMoney(item.converted_minor, item.converted_currency, { locale })
      : null;
  // A foreign-currency amount with no goal-currency pair: no rate exists for it,
  // so it is missing from every rolled-up sum above. Said on the row, and counted
  // again in the goal's own counter — never silently folded in.
  const unconverted =
    item.amount_minor !== null && item.currency !== goalCurrency && converted === null;

  // The date this node is ABOUT: the reminder when it has one, else the effective
  // (possibly inherited) deadline — the same anchor the deadlines widget sorts by.
  const anchor = item.remind_on ?? item.effective_deadline;
  const soon = isSoon(anchor, today, soonUntil);

  return (
    <View style={[styles.row, { marginLeft: (item.depth - 1) * INDENT_PER_LEVEL }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: detailsOpen }}
        accessibilityHint={t('goalPlan.detailsHint')}
        onPress={() => actions.onToggleDetails(item)}
        style={styles.head}
      >
        {row.hasChildren ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: !row.collapsed }}
            accessibilityLabel={t(row.collapsed ? 'goalPlan.expandNode' : 'goalPlan.collapseNode', {
              name: item.name,
            })}
            hitSlop={8}
            onPress={() => actions.onToggleCollapse(item)}
            style={styles.chevron}
          >
            <Text style={styles.chevronText}>{row.collapsed ? '▸' : '▾'}</Text>
          </Pressable>
        ) : (
          <View style={styles.chevron} />
        )}
        <View style={styles.headText}>
          {/* User-typed text: never translated. */}
          <Text style={styles.name} numberOfLines={2}>
            {item.name}
          </Text>
          <Text style={styles.meta}>
            {item.effective_deadline === null
              ? t('goalPlan.noDeadline')
              : item.deadline_inherited
                ? t('goalPlan.deadlineInherited', {
                    date: formatApiDate(item.effective_deadline, { locale }),
                  })
                : t('goalPlan.deadlineOwn', {
                    date: formatApiDate(item.effective_deadline, { locale }),
                  })}
            {/* A text mark, not colour alone. */}
            {soon ? ` · ${t('goalPlan.soon')}` : ''}
            {item.files_count > 0
              ? ` · ${t('goalPlan.filesCount', { count: item.files_count })}`
              : ''}
          </Text>
        </View>
        <View style={styles.amounts}>
          {ownAmount === null ? (
            <Text style={styles.muted}>{t('goalPlan.noOwnAmount')}</Text>
          ) : (
            <Text style={styles.own}>{ownAmount}</Text>
          )}
          {converted !== null ? (
            <Text style={styles.muted}>
              {t('goalPlan.convertedSuffix', { amount: converted })}
            </Text>
          ) : null}
          {row.hasChildren ? (
            <Text style={styles.muted}>
              {t('goalPlan.childrenSum', {
                amount: formatMoney(item.children_sum_minor, goalCurrency, { locale }),
              })}
            </Text>
          ) : null}
          {item.paid_minor > 0 ? (
            <Text style={styles.paid}>
              {t('goalPlan.paidOnNode', {
                amount: formatMoney(item.paid_minor, goalCurrency, { locale }),
              })}
            </Text>
          ) : null}
        </View>
      </Pressable>

      {item.ceiling_exceeded && item.amount_minor !== null ? (
        <Text style={styles.warn}>
          {t('goalPlan.ceilingExceeded', {
            own: formatMoney(item.amount_minor, item.currency, { locale }),
            children: formatMoney(item.children_sum_minor, goalCurrency, { locale }),
          })}
        </Text>
      ) : null}
      {unconverted ? (
        <Text style={styles.warn}>
          {t('goalPlan.nodeUnconverted', { from: item.currency, to: goalCurrency })}
        </Text>
      ) : null}
      {item.paid_unconverted_count > 0 ? (
        <Text style={styles.warn}>
          {t('goalPlan.nodePaidUnconverted', { count: item.paid_unconverted_count })}
        </Text>
      ) : null}

      {detailsOpen ? (
        <View style={styles.details}>
          {item.description !== null ? (
            <Text style={styles.description}>{item.description}</Text>
          ) : null}

          {/* Links are OPENED only for http(s): the server stores whatever was
              pasted, and handing an arbitrary scheme to the OS is not something a
              budget app should do. Everything else is shown as text, so nothing
              is lost. */}
          {item.links.map((link) =>
            /^https?:\/\//i.test(link) ? (
              <Pressable
                key={link}
                accessibilityRole="link"
                onPress={() => void Linking.openURL(link)}
                style={styles.link}
              >
                <Text style={styles.linkText} numberOfLines={1}>
                  {link}
                </Text>
              </Pressable>
            ) : (
              <Text key={link} style={styles.muted} numberOfLines={1}>
                {link}
              </Text>
            ),
          )}

          <ItemPhotos
            goalId={item.goal_id}
            itemId={item.id}
            filesCount={item.files_count}
            readOnly={readOnly}
          />

          {readOnly ? null : (
            <View style={styles.actions}>
              <RowAction
                label={t('goalPlan.moveUp')}
                accessibilityLabel={t('goalPlan.moveUpAria', { name: item.name })}
                disabled={pending || row.isFirst}
                onPress={() => actions.onReorder(item, 'up')}
              />
              <RowAction
                label={t('goalPlan.moveDown')}
                accessibilityLabel={t('goalPlan.moveDownAria', { name: item.name })}
                disabled={pending || row.isLast}
                onPress={() => actions.onReorder(item, 'down')}
              />
              {/* The server refuses a level past the limit; offering the button
                  there would be an affordance for a failure. */}
              {item.depth < MAX_PLAN_DEPTH ? (
                <RowAction
                  label={t('goalPlan.addChild')}
                  disabled={pending}
                  onPress={() => actions.onAddChild(item)}
                />
              ) : null}
              <RowAction
                label={t('common.edit')}
                disabled={pending}
                onPress={() => actions.onEdit(item)}
              />
              <RowAction
                label={t('goalPlan.moveTo')}
                disabled={pending}
                onPress={() => actions.onMove(item)}
              />
              <RowAction
                label={t('common.delete')}
                disabled={pending}
                destructive
                onPress={() => actions.onDelete(item)}
              />
            </View>
          )}
        </View>
      ) : null}
    </View>
  );
}

function RowAction({
  label,
  accessibilityLabel,
  disabled,
  destructive = false,
  onPress,
}: {
  label: string;
  accessibilityLabel?: string;
  disabled: boolean;
  destructive?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={styles.action}
    >
      <Text
        style={[
          styles.actionText,
          destructive && styles.actionDestructive,
          disabled && styles.actionDisabled,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export const PlanNodeRow = memo(PlanNodeRowImpl);

const styles = StyleSheet.create({
  row: {
    backgroundColor: colors.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.xs,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    minHeight: TOUCH_TARGET,
  },
  chevron: {
    width: 24,
    minHeight: TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chevronText: {
    fontSize: 16,
    color: colors.textMuted,
  },
  headText: {
    flex: 1,
    justifyContent: 'center',
    gap: 2,
  },
  name: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text,
  },
  meta: {
    fontSize: 12,
    color: colors.textMuted,
  },
  amounts: {
    alignItems: 'flex-end',
    justifyContent: 'center',
    gap: 2,
  },
  own: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text,
  },
  paid: {
    fontSize: 12,
    color: colors.income,
  },
  muted: {
    fontSize: 12,
    color: colors.textMuted,
  },
  warn: {
    fontSize: 12,
    color: colors.expense,
  },
  details: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
    gap: spacing.xs,
  },
  description: {
    fontSize: 13,
    color: colors.text,
  },
  link: {
    minHeight: TOUCH_TARGET,
    justifyContent: 'center',
  },
  linkText: {
    fontSize: 13,
    color: colors.primary,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  action: {
    minHeight: TOUCH_TARGET,
    paddingHorizontal: spacing.sm,
    justifyContent: 'center',
  },
  actionText: {
    fontSize: 14,
    color: colors.primary,
    fontWeight: '600',
  },
  actionDestructive: {
    color: colors.danger,
  },
  actionDisabled: {
    color: colors.disabled,
  },
});
