// What this goal costs and where it stands — every number a SERVER field. The
// mobile port of web's features/goals/plan/PlanSummary.tsx + FinalCostSection's
// read-only half (the EDIT of the two manual fields is its own modal screen,
// goal-cost-form, because a text input inside a list header on a phone is a
// keyboard trap).
//
// Progress is THREE separate figures: paid (money that has left), saved (money
// that is lying there) and what is still to be found. They are never added
// together — one combined number would suggest money that does not exist — and
// `remaining_to_find_minor` is the server's subtraction, not the client's.
//
// The cost block states the goal's MODE honestly:
//   no items           — the manual target, exactly as before the plan existed;
//   items, no override — the total is assembled BOTTOM-UP and will keep growing
//                        as items are added (without saying so, a goal looks like
//                        it is getting pricier by itself);
//   items + override   — BOTH numbers side by side. Neither replaces the other.
// In both item modes the amount set BEFORE the plan existed stays on screen as a
// read-only reference line — the transition confirm promises exactly that.
import { formatMoney } from '@budget/shared';
import { StyleSheet, Text, View } from 'react-native';

import { FormButton } from '../../../components/FormButton';
import { colors, spacing } from '../../../components/theme';
import type { GoalRead } from '../../../data/goals';
import { useLocale, useT } from '../../../i18n/context';

interface PlanSummaryProps {
  goal: GoalRead;
  /** Open goal-cost-form. Absent on an archived goal, which takes no writes. */
  onEditCost?: () => void;
}

export function PlanSummary({ goal, onEditCost }: PlanSummaryProps) {
  const t = useT();
  const locale = useLocale();
  const currency = goal.goal_currency;

  return (
    <View style={styles.card}>
      {goal.has_items ? (
        goal.final_cost_override_minor !== null ? (
          <>
            <CostLine
              label={t('goalPlan.finalCostManual')}
              value={formatMoney(goal.final_cost_override_minor, currency, { locale })}
              strong
            />
            <CostLine
              label={t('goalPlan.plannedTotal')}
              value={formatMoney(goal.planned_total_minor, currency, { locale })}
            />
          </>
        ) : (
          <>
            <CostLine
              label={t('goalPlan.finalCostBottomUp')}
              value={formatMoney(goal.effective_target_minor, currency, { locale })}
              strong
            />
            <Text style={styles.note}>{t('goalPlan.planIncomplete')}</Text>
          </>
        )
      ) : (
        <CostLine
          label={t('goalPlan.manualTarget')}
          // AM-5: the manual target is denominated in the GOAL's own currency.
          value={formatMoney(goal.target_minor, goal.currency, { locale })}
          strong
        />
      )}

      {goal.has_items ? (
        <CostLine
          label={t('goalPlan.targetBeforePlan')}
          value={formatMoney(goal.target_minor, goal.currency, { locale })}
        />
      ) : null}

      {goal.initial_budget_minor !== null ? (
        <CostLine
          label={t('goalPlan.initialBudget')}
          value={formatMoney(goal.initial_budget_minor, currency, { locale })}
        />
      ) : null}

      <View style={styles.figures}>
        <Figure label={t('goalPlan.paid')} value={formatMoney(goal.paid_minor, currency, { locale })} />
        <Figure label={t('goalPlan.saved')} value={formatMoney(goal.saved_minor, currency, { locale })} />
        <Figure
          label={t('goalPlan.remaining')}
          // Can be negative, and is shown as such: the server decided it.
          value={formatMoney(goal.remaining_to_find_minor, currency, { locale })}
        />
      </View>

      {/* Amounts that could not be converted into the goal's currency are their
          own COUNTER lines — never hidden, never folded in. */}
      {goal.planned_unconverted_count > 0 ? (
        <Text style={styles.warn}>
          {t('goalPlan.plannedUnconverted', {
            count: goal.planned_unconverted_count,
            currency,
          })}
        </Text>
      ) : null}
      {goal.paid_unconverted_count > 0 ? (
        <Text style={styles.warn}>
          {t('goalPlan.paidUnconverted', { count: goal.paid_unconverted_count, currency })}
        </Text>
      ) : null}

      {onEditCost ? (
        <FormButton
          label={t('goalPlan.editCost')}
          variant="secondary"
          onPress={onEditCost}
        />
      ) : null}
    </View>
  );
}

function CostLine({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <View style={styles.costLine}>
      <Text style={styles.costLabel}>{label}</Text>
      <Text style={[styles.costValue, strong && styles.costValueStrong]}>{value}</Text>
    </View>
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

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  costLine: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  costLabel: {
    flex: 1,
    fontSize: 13,
    color: colors.textMuted,
  },
  costValue: {
    fontSize: 15,
    color: colors.text,
  },
  costValueStrong: {
    fontSize: 20,
    fontWeight: '700',
  },
  note: {
    fontSize: 12,
    color: colors.textMuted,
  },
  figures: {
    flexDirection: 'row',
    gap: spacing.md,
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
  warn: {
    fontSize: 12,
    color: colors.expense,
  },
});
