// The goal's two MANUAL money fields (mobile-catchup-3, line C) — web's
// FinalCostSection as its own modal screen.
//
// It is not part of the goal form: a manual final cost only means something next
// to the bottom-up sum it overrides, and that sum lives on the plan screen. So the
// planned total is on screen here, above the field, and stays there whatever is
// typed — the override never REPLACES it, it sits beside it, so the discrepancy
// the user is deciding about is always readable.
//
// Both fields are PATCH-only by contract (`GoalCreate` carries neither), and both
// follow the omit / value / null discipline: an untouched field is not sent, a
// cleared one is sent as an explicit null ("back to the sum of the items").
import { zodResolver } from '@hookform/resolvers/zod';
import { formatMoney, toInputString } from '@budget/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { type ReactNode } from 'react';
import { Controller, useForm, type Resolver } from 'react-hook-form';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FieldError } from '../../src/components/FieldError';
import { FormButton } from '../../src/components/FormButton';
import { KeyboardAwareForm } from '../../src/components/KeyboardAwareForm';
import { LabeledInput } from '../../src/components/LabeledInput';
import { colors, spacing } from '../../src/components/theme';
import { describeGoalError } from '../../src/data/errors';
import { useGoal, useUpdateGoal, type GoalRead } from '../../src/data/goals';
import {
  goalCostFormSchema,
  type GoalCostFormInput,
  type GoalCostFormValues,
} from '../../src/features/goals/plan/goalCostFormSchema';
import { useLang, useLocale, useT } from '../../src/i18n/context';
import { normalizeAmountInput } from '../../src/lib/amountInput';

export default function GoalCostFormScreen() {
  const t = useT();
  const params = useLocalSearchParams<{ id?: string }>();
  const goalId = params.id;
  const goalQuery = useGoal(goalId ?? '', goalId !== undefined);

  if (goalId === undefined || goalQuery.data === undefined) {
    return (
      <Shell title={t('goalPlan.costTitle')}>
        {goalQuery.isPending && goalId !== undefined ? (
          <Text style={styles.notice}>{t('common.loading')}</Text>
        ) : (
          <>
            <Text accessibilityRole="alert" style={styles.unavailable}>
              {t('goalForm.unavailable')}
            </Text>
            <FormButton
              label={t('common.goBack')}
              variant="secondary"
              onPress={() => router.back()}
            />
          </>
        )}
      </Shell>
    );
  }

  return <GoalCostFormBody goal={goalQuery.data} />;
}

function GoalCostFormBody({ goal }: { goal: GoalRead }) {
  const t = useT();
  const lang = useLang();
  const locale = useLocale();
  const currency = goal.goal_currency;
  const updateGoal = useUpdateGoal();

  const defaultValues: GoalCostFormInput = {
    final_cost:
      goal.final_cost_override_minor === null
        ? ''
        : toInputString(goal.final_cost_override_minor, currency),
    initial_budget:
      goal.initial_budget_minor === null
        ? ''
        : toInputString(goal.initial_budget_minor, currency),
  };

  const resolver: Resolver<GoalCostFormInput, unknown, GoalCostFormValues> = (
    values,
    context,
    options,
  ) =>
    zodResolver(goalCostFormSchema(currency, t))(
      {
        final_cost: normalizeAmountInput(values.final_cost),
        initial_budget: normalizeAmountInput(values.initial_budget),
      },
      context,
      options,
    );

  const {
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<GoalCostFormInput, unknown, GoalCostFormValues>({ resolver, defaultValues });

  // A manual total only MEANS something once the goal has items to override: with
  // no plan the goal's amount IS its target, and offering a second one would be a
  // control that changes nothing. It stays visible when a stored override
  // outlives the last item — otherwise there would be no way to clear it.
  const showFinalCost = goal.has_items || goal.final_cost_override_minor !== null;

  const onSubmit = handleSubmit(async (values) => {
    const patch: Parameters<typeof updateGoal.mutateAsync>[0]['body'] = {};
    if (values.final_cost !== goal.final_cost_override_minor) {
      patch.final_cost_override_minor = values.final_cost;
    }
    if (values.initial_budget !== goal.initial_budget_minor) {
      patch.initial_budget_minor = values.initial_budget;
    }
    if (Object.keys(patch).length === 0) {
      router.back();
      return;
    }

    try {
      await updateGoal.mutateAsync({ id: goal.id, body: patch });
      router.back();
    } catch (error) {
      const { field, message } = describeGoalError(error, lang);
      setError(
        field === 'final_cost_override_minor'
          ? 'final_cost'
          : field === 'initial_budget_minor'
            ? 'initial_budget'
            : 'root',
        { message },
      );
    }
  });

  const pending = isSubmitting || updateGoal.isPending;

  return (
    <Shell
      title={t('goalPlan.costTitle')}
      footer={<FormButton label={t('common.save')} onPress={onSubmit} pending={pending} />}
    >
      <FieldError message={errors.root?.message} />

      {showFinalCost ? (
        <>
          <Text style={styles.lede}>
            {t('goalPlan.costLede', {
              amount: formatMoney(goal.planned_total_minor, currency, { locale }),
            })}
          </Text>
          <Controller
            control={control}
            name="final_cost"
            render={({ field }) => (
              <LabeledInput
                label={`${t('goalPlan.finalCostLabel')} ${t('common.optional')}`}
                keyboardType="decimal-pad"
                value={field.value}
                onChangeText={field.onChange}
                onBlur={field.onBlur}
                hint={t('goalPlan.finalCostHint', { currency })}
                error={errors.final_cost?.message}
              />
            )}
          />
        </>
      ) : null}

      <Controller
        control={control}
        name="initial_budget"
        render={({ field }) => (
          <LabeledInput
            label={`${t('goalPlan.initialBudgetLabel')} ${t('common.optional')}`}
            keyboardType="decimal-pad"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            hint={t('goalPlan.initialBudgetHint', { currency })}
            error={errors.initial_budget?.message}
          />
        )}
      />
    </Shell>
  );
}

function Shell({
  title,
  children,
  footer,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const t = useT();
  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" onPress={() => router.back()} hitSlop={8}>
          <Text style={styles.cancel}>{t('common.cancel')}</Text>
        </Pressable>
        <Text style={styles.title}>{title}</Text>
        <View style={styles.headerSpacer} />
      </View>
      <KeyboardAwareForm footer={footer}>{children}</KeyboardAwareForm>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.card,
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.text,
  },
  cancel: {
    fontSize: 16,
    color: colors.primary,
    minWidth: 60,
  },
  headerSpacer: {
    minWidth: 60,
  },
  lede: {
    fontSize: 13,
    color: colors.textMuted,
  },
  notice: {
    fontSize: 14,
    color: colors.textMuted,
  },
  unavailable: {
    fontSize: 15,
    color: colors.danger,
  },
});
