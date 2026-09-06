// One goal card (memoized for the virtualized list) — the mobile port of web's
// features/goals/GoalCard.tsx.
//
// Every number here is a SERVER field formatted through the shared helpers, and
// the card carries TWO currencies at once:
//   goal.currency / goal.goal_currency — target, the three progress figures,
//                                        monthly needed;
//   goal.base_currency                 — `allocated_monthly_minor`, a share of the
//                                        base-currency free balance.
// Each field is formatted with ITS OWN currency; neither is ever a fallback for
// the other (AM-5).
//
// Two deliberate absences against web: no progress BAR and no chart. The bar
// would have to pick one of the three progress figures, and adding "saved + paid"
// into one number is precisely what task.md forbids; there is no chart library on
// this client at all.
import { formatApiDate, formatMoney } from '@budget/shared';
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, spacing, TOUCH_TARGET } from '../../components/theme';
import type { GoalRead } from '../../data/goals';
import { useLocale, useT } from '../../i18n/context';
import { realismContent } from './realism';

interface GoalCardProps {
  goal: GoalRead;
  /** Open the plan screen for this goal. */
  onOpen: (goal: GoalRead) => void;
  /** Open the goal form for this goal. */
  onEdit: (goal: GoalRead) => void;
}

function GoalCardImpl({ goal, onOpen, onEdit }: GoalCardProps) {
  const t = useT();
  const locale = useLocale();
  const realism = realismContent(goal);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={goal.name}
      accessibilityHint={t('goals.openPlanHint')}
      onPress={() => onOpen(goal)}
      style={[styles.card, goal.archived && styles.archived]}
    >
      <View style={styles.header}>
        {/* The goal's NAME is user-typed and never translated. */}
        <Text style={styles.name} numberOfLines={2}>
          {goal.name}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('goals.editAria', { name: goal.name })}
          onPress={() => onEdit(goal)}
          hitSlop={8}
          style={styles.editButton}
        >
          <Text style={styles.editButtonText}>✎</Text>
        </Pressable>
      </View>

      <View style={styles.tags}>
        {goal.completed ? (
          <Text style={[styles.tag, styles.tagGood]}>{t('goalCard.reached')}</Text>
        ) : null}
        {goal.archived ? <Text style={styles.tag}>{t('common.archivedTag')}</Text> : null}
        <Text style={styles.tag}>{t('goalCard.priority', { value: goal.priority })}</Text>
      </View>

      {/* A goal with a PLAN is a different fact from a goal with a manual target,
          and the card says which one it is. */}
      {goal.has_items ? (
        <>
          <Text style={styles.headline}>
            {formatMoney(goal.effective_target_minor, goal.goal_currency, { locale })}
          </Text>
          <Text style={styles.headlineCaption}>{t('goalCard.effectiveTarget')}</Text>
          {/* What the goal was planned at BEFORE the plan existed, kept visible. */}
          <Text style={styles.muted}>
            {t('goalCard.targetBeforePlan', {
              amount: formatMoney(goal.target_minor, goal.currency, { locale }),
            })}
          </Text>
          {goal.final_cost_override_minor === null ? (
            <Text style={styles.muted}>{t('goalCard.planBottomUp')}</Text>
          ) : null}
        </>
      ) : (
        <>
          <Text style={styles.headline}>
            {formatMoney(goal.saved_minor, goal.currency, { locale })}
          </Text>
          <Text style={styles.headlineCaption}>
            {t('goalCard.ofTarget', {
              target: formatMoney(goal.target_minor, goal.currency, { locale }),
            })}
          </Text>
        </>
      )}

      {/* THREE figures, never summed: money that has LEFT, money that is LYING
          THERE, and what is still to be found. `remaining_to_find_minor` is the
          server's subtraction, not this client's. */}
      <View style={styles.figures}>
        <Figure label={t('goalPlan.paid')} value={formatMoney(goal.paid_minor, goal.goal_currency, { locale })} />
        <Figure label={t('goalPlan.saved')} value={formatMoney(goal.saved_minor, goal.goal_currency, { locale })} />
        <Figure
          label={t('goalPlan.remaining')}
          value={formatMoney(goal.remaining_to_find_minor, goal.goal_currency, { locale })}
        />
      </View>

      {/* Honest counters, never folded into a figure above. */}
      {goal.planned_unconverted_count > 0 ? (
        <Text style={styles.warn}>
          {t('goalPlan.plannedUnconverted', {
            count: goal.planned_unconverted_count,
            currency: goal.goal_currency,
          })}
        </Text>
      ) : null}
      {goal.paid_unconverted_count > 0 ? (
        <Text style={styles.warn}>
          {t('goalPlan.paidUnconverted', {
            count: goal.paid_unconverted_count,
            currency: goal.goal_currency,
          })}
        </Text>
      ) : null}

      <Text style={styles.muted}>
        {goal.deadline
          ? t('goalCard.deadline', { date: formatApiDate(goal.deadline, { locale }) })
          : t('goalCard.noDeadline')}
      </Text>

      {realism.status === 'completed' ? (
        <Text style={styles.good}>{t('goalCard.completed')}</Text>
      ) : null}
      {realism.status === 'unavailable' ? (
        <Text style={styles.warn}>
          {t('goalCard.realismUnavailable', { currency: realism.currency })}
        </Text>
      ) : null}
      {realism.status === 'no-deadline' ? (
        <Text style={styles.muted}>{t('goalCard.noDeadlineHint')}</Text>
      ) : null}
      {realism.status === 'on-track' ? (
        <Text style={styles.good}>
          {t('goalCard.onTrack', {
            amount: formatMoney(realism.monthlyNeededMinor, goal.currency, { locale }),
          })}
        </Text>
      ) : null}
      {realism.status === 'behind-movable' ? (
        <>
          <Text style={styles.warn}>
            {t('goalCard.behindTitle', {
              amount: formatMoney(realism.monthlyNeededMinor, goal.currency, { locale }),
            })}
          </Text>
          <Text style={styles.muted}>
            {/* The months phrase is a PLURAL entry (ru needs one/few/many); the
                sentence it is wrapped in depends on whether the server sent a
                suggested deadline. */}
            {realism.suggestedDeadline
              ? t('goalCard.monthsWithSuggestion', {
                  months: t('goalCard.monthsToTarget', { count: realism.monthsToTarget }),
                  date: formatApiDate(realism.suggestedDeadline, { locale }),
                })
              : t('goalCard.monthsPlain', {
                  months: t('goalCard.monthsToTarget', { count: realism.monthsToTarget }),
                })}
          </Text>
        </>
      ) : null}
      {realism.status === 'behind-unreachable' ? (
        <>
          <Text style={styles.warn}>
            {t('goalCard.behindTitle', {
              amount: formatMoney(realism.monthlyNeededMinor, goal.currency, { locale }),
            })}
          </Text>
          <Text style={styles.muted}>{t('goalCard.behindUnreachable')}</Text>
        </>
      ) : null}

      {/* The waterfall share, in the PROFILE BASE currency — a different currency
          from everything above it, formatted with its own. */}
      {goal.allocated_monthly_minor > 0 ? (
        <Text style={styles.muted}>
          {t('goalCard.allocated', {
            amount: formatMoney(goal.allocated_monthly_minor, goal.base_currency, { locale }),
          })}
        </Text>
      ) : !goal.archived && !goal.completed && !goal.realism_unavailable ? (
        <Text style={styles.muted}>{t('goalCard.noAllocation')}</Text>
      ) : null}
    </Pressable>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.figure}>
      <Text style={styles.figureLabel}>{label}</Text>
      <Text style={styles.figureValue}>{value}</Text>
    </View>
  );
}

export const GoalCard = memo(GoalCardImpl);

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.xs,
  },
  archived: {
    opacity: 0.7,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  name: {
    flex: 1,
    fontSize: 17,
    fontWeight: '700',
    color: colors.text,
  },
  editButton: {
    width: TOUCH_TARGET,
    height: TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  editButtonText: {
    fontSize: 20,
    color: colors.primary,
  },
  tags: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  tag: {
    fontSize: 12,
    color: colors.textMuted,
  },
  tagGood: {
    color: colors.income,
    fontWeight: '600',
  },
  headline: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.text,
  },
  headlineCaption: {
    fontSize: 13,
    color: colors.textMuted,
  },
  figures: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.xs,
  },
  figure: {
    flex: 1,
    gap: 2,
  },
  figureLabel: {
    fontSize: 12,
    color: colors.textMuted,
  },
  figureValue: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text,
  },
  muted: {
    fontSize: 13,
    color: colors.textMuted,
  },
  good: {
    fontSize: 13,
    color: colors.income,
  },
  warn: {
    fontSize: 13,
    color: colors.expense,
  },
});
