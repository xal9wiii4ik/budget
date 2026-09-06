// Create / edit / archive / delete one goal (mobile-catchup-3, line C) — the
// account-form screen's shape with web's GoalFormModal decisions on top.
//
// Deep-link-safe: an edit reads `GET /goals/{id}` (`useGoal`), not a row picked
// out of a cached list — a cold link into this screen has no list. A create reads
// the goals LIST only for the profile `base_currency`, which is the default
// currency pick and nothing else (AM-4: never guessed, never used to decode).
//
// ONE deliberate divergence from web: the currency is READ-ONLY after create,
// like an account's. Web offers a currency change behind a confirm because the
// change RELABELS the ledger (contribution rows keep their numbers and are simply
// read as the new currency); that is a decision worth a wide dialog and a careful
// read, and a phone modal is the wrong place to make it. The read-only arm says
// where it can be done.
//
// The two plan money fields (final cost override, initial budget) are NOT here:
// they only mean something next to the bottom-up sum they override, and that sum
// is on the plan screen (goal-cost-form).
import { zodResolver } from '@hookform/resolvers/zod';
import {
  goalFormSchema,
  SUPPORTED_CURRENCIES,
  toInputString,
  type GoalFormInput,
  type GoalFormValues,
} from '@budget/shared';
import { buildGoalPatch } from '@budget/api-client';
import { router, useLocalSearchParams } from 'expo-router';
import { type ReactNode } from 'react';
import { Controller, useForm, useWatch, type Resolver } from 'react-hook-form';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { confirmAction } from '../../src/components/confirm';
import { DateField } from '../../src/components/DateField';
import { FieldError } from '../../src/components/FieldError';
import { FormButton } from '../../src/components/FormButton';
import { KeyboardAwareForm } from '../../src/components/KeyboardAwareForm';
import { LabeledInput } from '../../src/components/LabeledInput';
import { colors, spacing, TOUCH_TARGET } from '../../src/components/theme';
import { describeGoalError } from '../../src/data/errors';
import {
  useCreateGoal,
  useDeleteGoal,
  useGoal,
  useGoals,
  useUpdateGoal,
  type GoalRead,
} from '../../src/data/goals';
import { useLang, useT } from '../../src/i18n/context';
import { normalizeAmountInput } from '../../src/lib/amountInput';

export default function GoalFormScreen() {
  const t = useT();
  const params = useLocalSearchParams<{ id?: string }>();
  const id = params.id;
  const isEdit = id !== undefined;

  // Edit: the single GET (deep-link safe). Create: the list, for its
  // `base_currency` alone.
  const goalQuery = useGoal(id ?? '', isEdit);
  const goalsQuery = useGoals(false);

  if (isEdit && goalQuery.isPending) {
    return (
      <Shell title={t('goalForm.editTitle')}>
        <Text style={styles.notice}>{t('common.loading')}</Text>
      </Shell>
    );
  }

  if (isEdit && goalQuery.data === undefined) {
    return (
      <Shell title={t('goalForm.editTitle')}>
        <Text accessibilityRole="alert" style={styles.unavailable}>
          {t('goalForm.unavailable')}
        </Text>
        <FormButton
          label={t('common.retry')}
          variant="secondary"
          onPress={() => goalQuery.refetch()}
        />
        <FormButton
          label={t('common.goBack')}
          variant="secondary"
          onPress={() => router.back()}
        />
      </Shell>
    );
  }

  if (!isEdit && goalsQuery.isPending) {
    return (
      <Shell title={t('goalForm.newTitle')}>
        <Text style={styles.notice}>{t('common.loading')}</Text>
      </Shell>
    );
  }

  return (
    <GoalFormBody
      goal={goalQuery.data}
      // The base currency is a DEFAULT PICK. With the list unreachable the first
      // supported code is a default too — nothing is decoded before the user
      // picks, so this is not an AM-5 guess.
      baseCurrency={goalsQuery.data?.base_currency ?? SUPPORTED_CURRENCIES[0]}
    />
  );
}

function GoalFormBody({
  goal,
  baseCurrency,
}: {
  goal: GoalRead | undefined;
  baseCurrency: string;
}) {
  const t = useT();
  const lang = useLang();
  const isEdit = goal !== undefined;

  const createGoal = useCreateGoal();
  const updateGoal = useUpdateGoal();
  const archiveGoal = useUpdateGoal();
  const deleteGoal = useDeleteGoal();

  const defaultValues: GoalFormInput = goal
    ? {
        name: goal.name,
        // AM-5: the target decodes with the GOAL's own currency, never the base.
        target: toInputString(goal.target_minor, goal.currency),
        currency: goal.currency,
        deadline: goal.deadline ?? '',
        priority: String(goal.priority),
        initial_saved: '',
      }
    : {
        name: '',
        target: '',
        currency: baseCurrency,
        deadline: '',
        priority: '',
        initial_saved: '',
      };

  // Output-shaped baseline for the PATCH diff.
  const initial: GoalFormValues = {
    name: goal?.name ?? '',
    target_minor: goal?.target_minor ?? 0,
    currency: goal?.currency ?? baseCurrency,
    deadline: goal?.deadline ?? null,
    priority: goal?.priority ?? null,
    // Create-only; it has no PATCH representation (buildGoalPatch drops it).
    initial_saved_minor: null,
  };

  // F-1: the decimal-pad's separator key is the DEVICE locale's (',' on ru-RU)
  // while the shared parser accepts '.' only. Normalize at this boundary — the
  // fields keep showing what was typed; only the validated value is normalized.
  const resolver: Resolver<GoalFormInput, unknown, GoalFormValues> = (
    values,
    context,
    options,
  ) =>
    zodResolver(goalFormSchema)(
      {
        ...values,
        target: normalizeAmountInput(values.target),
        initial_saved: normalizeAmountInput(values.initial_saved),
      },
      context,
      options,
    );

  const {
    control,
    handleSubmit,
    setError,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<GoalFormInput, unknown, GoalFormValues>({ resolver, defaultValues });

  const currency = useWatch({ control, name: 'currency' });

  const routeError = (error: unknown) => {
    const { field, message } = describeGoalError(error, lang);
    // The two plan money fields are edited on the PLAN screen and this form never
    // sends them — a 422 naming one is a bug signal, so it lands at form level
    // rather than on an input that does not exist here.
    const target =
      field === 'form' ||
      field === 'initial_budget_minor' ||
      field === 'final_cost_override_minor'
        ? 'root'
        : field === 'target_minor'
          ? 'target'
          : field === 'initial_saved_minor'
            ? 'initial_saved'
            : field;
    setError(target, { message });
  };

  const onSubmit = handleSubmit(async (values) => {
    try {
      if (isEdit && goal) {
        const patch = buildGoalPatch(values, initial);
        if (Object.keys(patch).length > 0) {
          await updateGoal.mutateAsync({ id: goal.id, body: patch });
        }
      } else {
        await createGoal.mutateAsync({
          name: values.name,
          target_minor: values.target_minor,
          currency: values.currency,
          deadline: values.deadline,
          priority: values.priority,
          initial_saved_minor: values.initial_saved_minor,
        });
      }
      router.back();
    } catch (error) {
      routeError(error);
    }
  });

  const onArchiveToggle = () => {
    if (!goal) return;
    const archiving = !goal.archived;
    confirmAction({
      cancelLabel: t('common.cancel'),
      title: t(archiving ? 'goalForm.archiveTitle' : 'goalForm.unarchiveTitle'),
      // The goal NAME is interpolated, never translated.
      message: t(archiving ? 'goalForm.archiveMessage' : 'goalForm.unarchiveMessage', {
        name: goal.name,
      }),
      confirmLabel: t(archiving ? 'common.archive' : 'common.unarchive'),
      destructive: archiving,
      onConfirm: () => {
        archiveGoal.mutate(
          { id: goal.id, body: { archived: archiving } },
          { onSuccess: () => router.back(), onError: routeError },
        );
      },
    });
  };

  // DELETE exists on the contract (unlike accounts) and takes the goal's whole
  // plan and ledger with it — hence the destructive confirm that says so, with
  // archive offered right beside it as the reversible way out.
  const onDelete = () => {
    if (!goal) return;
    confirmAction({
      cancelLabel: t('common.cancel'),
      title: t('goalForm.deleteTitle'),
      message: t('goalForm.deleteMessage', { name: goal.name }),
      confirmLabel: t('common.delete'),
      destructive: true,
      onConfirm: () => {
        deleteGoal.mutate(
          { id: goal.id },
          { onSuccess: () => router.back(), onError: routeError },
        );
      },
    });
  };

  const pending = isSubmitting || createGoal.isPending || updateGoal.isPending;
  const currencyOptions: string[] = SUPPORTED_CURRENCIES.includes(
    currency as (typeof SUPPORTED_CURRENCIES)[number],
  )
    ? [...SUPPORTED_CURRENCIES]
    : [...SUPPORTED_CURRENCIES, currency];

  return (
    <Shell
      title={t(isEdit ? 'goalForm.editTitle' : 'goalForm.newTitle')}
      footer={
        <>
          <FormButton label={t('common.save')} onPress={onSubmit} pending={pending} />
          {isEdit && goal ? (
            <>
              <FormButton
                label={t(goal.archived ? 'common.unarchive' : 'common.archive')}
                variant="secondary"
                onPress={onArchiveToggle}
                pending={archiveGoal.isPending}
              />
              <FormButton
                label={t('common.delete')}
                variant="danger"
                onPress={onDelete}
                pending={deleteGoal.isPending}
              />
            </>
          ) : null}
        </>
      }
    >
      <FieldError message={errors.root?.message} />

      <Controller
        control={control}
        name="name"
        render={({ field }) => (
          <LabeledInput
            label={t('common.name')}
            maxLength={100}
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={errors.name?.message}
          />
        )}
      />

      <Controller
        control={control}
        name="target"
        render={({ field }) => (
          <LabeledInput
            label={t('goalForm.target', { currency })}
            keyboardType="decimal-pad"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={errors.target?.message}
          />
        )}
      />

      <View style={styles.field}>
        <Text style={styles.label}>{t('common.currency')}</Text>
        {isEdit ? (
          <>
            <Text style={styles.readonlyValue}>{currency}</Text>
            <Text style={styles.hint}>{t('goalForm.currencyImmutableHint')}</Text>
          </>
        ) : (
          <View style={styles.chips}>
            {currencyOptions.map((code) => (
              <Chip
                key={code}
                label={code}
                selected={currency === code}
                onPress={() => setValue('currency', code)}
              />
            ))}
          </View>
        )}
        <FieldError message={errors.currency?.message} />
      </View>

      <Controller
        control={control}
        name="deadline"
        render={({ field }) => (
          <DateField
            label={`${t('goalForm.deadline')} ${t('common.optional')}`}
            value={field.value}
            onChange={field.onChange}
            hint={t('goalForm.deadlineHint')}
            error={errors.deadline?.message}
            clearable
          />
        )}
      />

      <Controller
        control={control}
        name="priority"
        render={({ field }) => (
          <LabeledInput
            label={`${t('goalForm.priority')} ${t('common.optional')}`}
            keyboardType="number-pad"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            hint={`${t('goalForm.priorityHint')} ${t(
              isEdit ? 'goalForm.priorityHintEdit' : 'goalForm.priorityHintCreate',
            )}`}
            error={errors.priority?.message}
          />
        )}
      />

      {!isEdit ? (
        <Controller
          control={control}
          name="initial_saved"
          render={({ field }) => (
            <LabeledInput
              label={`${t('goalForm.initialSaved')} ${t('common.optional')}`}
              keyboardType="decimal-pad"
              value={field.value}
              onChangeText={field.onChange}
              onBlur={field.onBlur}
              hint={t('goalForm.initialSavedHint', { currency })}
              error={errors.initial_saved?.message}
            />
          )}
        />
      ) : null}
    </Shell>
  );
}

function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.chip, selected && styles.chipSelected]}
    >
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
    </Pressable>
  );
}

// `footer` is the form's primary actions, pinned above the home-indicator strip
// by KeyboardAwareForm (D-4) instead of scrolling away at the end of the fields.
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
  field: {
    gap: spacing.xs,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
  },
  readonlyValue: {
    fontSize: 16,
    color: colors.text,
    paddingVertical: spacing.sm,
  },
  hint: {
    fontSize: 12,
    color: colors.textMuted,
  },
  notice: {
    color: colors.textMuted,
    fontSize: 14,
  },
  unavailable: {
    color: colors.danger,
    fontSize: 15,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  chip: {
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
});
