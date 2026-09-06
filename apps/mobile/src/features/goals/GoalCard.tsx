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
import { Pressable, Text, View } from 'react-native';

import { Badge } from '../../components/Badge';
import { themedStyles } from '../../theme/themedStyles';
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
  const styles = useStyles();
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
        {goal.completed ? <Badge label={t('goalCard.reached')} tone="success" /> : null}
        {goal.archived ? <Badge label={t('common.archivedTag')} /> : null}
        <Badge label={t('goalCard.priority', { value: goal.priority })} />
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
  const styles = useStyles();
  return (
    <View style={styles.figure}>
      <Text style={styles.figureLabel}>{label}</Text>
      <Text style={styles.figureValue}>{value}</Text>
    </View>
  );
}

export const GoalCard = memo(GoalCardImpl);

const useStyles = themedStyles((t) => ({
  card: {
    backgroundColor: t.colors.surface,
    borderRadius: t.radius.lg,
    borderWidth: 1,
    borderColor: t.colors.border,
    padding: t.spacing.md,
    gap: t.spacing.xs,
  },
  archived: {
    opacity: 0.7,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: t.spacing.sm,
  },
  name: {
    flex: 1,
    fontSize: t.type.lg,
    fontWeight: '700',
    color: t.colors.text,
  },
  editButton: {
    width: t.TOUCH_TARGET,
    height: t.TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  editButtonText: {
    fontSize: t.type.xl,
    color: t.colors.accent,
  },
  tags: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: t.spacing.sm,
  },
  headline: {
    fontSize: t.type.xl,
    fontWeight: '700',
    color: t.colors.text,
    ...t.tnum,
  },
  headlineCaption: {
    fontSize: t.type.sm,
    color: t.colors.textMuted,
    ...t.tnum,
  },
  figures: {
    flexDirection: 'row',
    gap: t.spacing.md,
    marginTop: t.spacing.xs,
  },
  figure: {
    flex: 1,
    gap: 2,
  },
  figureLabel: {
    fontSize: t.type.xs,
    color: t.colors.textMuted,
  },
  figureValue: {
    fontSize: t.type.md,
    fontWeight: '600',
    color: t.colors.text,
    ...t.tnum,
  },
  muted: {
    fontSize: t.type.sm,
    color: t.colors.textMuted,
    ...t.tnum,
  },
  good: {
    fontSize: t.type.sm,
    color: t.colors.success,
    ...t.tnum,
  },
  // A ceiling, an unconverted amount or a missed pace is a WARNING, not an
  // expense: it gets the warning token, never the money-out colour.
  warn: {
    fontSize: t.type.sm,
    color: t.colors.warning,
    ...t.tnum,
  },
}));
