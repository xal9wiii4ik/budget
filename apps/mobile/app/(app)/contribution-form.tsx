// Put money into a goal, or take it out (mobile-catchup-3, line C) — the port of
// web's ContributionModal.
//
// The form collects a MAGNITUDE plus a direction, and `signedAmountMinor`
// (@budget/shared) applies the ledger sign once, at this single call site: the API
// row is signed, so a withdrawal is a negative amount.
//
// The "you can't withdraw more than you saved" rule is deliberately NOT
// re-implemented here as a client-side gate: the server owns the SUM >= 0
// invariant across rows, and a stale local `saved_minor` would either block a
// legal withdrawal or wave an illegal one through. Its 422 lands on the amount.
//
// Deep-link-safe: the goal comes from `GET /goals/{id}`, and its CURRENCY is what
// the amount is parsed with (AM-5) — which is why the screen waits for it instead
// of guessing a base.
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contributionFormSchema,
  signedAmountMinor,
  todayApiDate,
  type ContributionFormInput,
  type ContributionFormValues,
} from '@budget/shared';
import { emptyToNull } from '@budget/api-client';
import { router, useLocalSearchParams } from 'expo-router';
import { type ReactNode } from 'react';
import { Controller, useForm, useWatch, type Resolver } from 'react-hook-form';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { DateField } from '../../src/components/DateField';
import { FieldError } from '../../src/components/FieldError';
import { FormButton } from '../../src/components/FormButton';
import { KeyboardAwareForm } from '../../src/components/KeyboardAwareForm';
import { LabeledInput } from '../../src/components/LabeledInput';
import { themedStyles } from '../../src/theme/themedStyles';
import { describeContributionError } from '../../src/data/errors';
import { useAddContribution, useGoal, type GoalRead } from '../../src/data/goals';
import { useLang, useT } from '../../src/i18n/context';
import { normalizeAmountInput } from '../../src/lib/amountInput';

export default function ContributionFormScreen() {
  const t = useT();
  const styles = useStyles();
  const params = useLocalSearchParams<{ id?: string }>();
  const goalId = params.id;
  const goalQuery = useGoal(goalId ?? '', goalId !== undefined);

  if (goalId === undefined || goalQuery.data === undefined) {
    return (
      <Shell title={t('contribution.shortTitle')}>
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

  return <ContributionFormBody goal={goalQuery.data} />;
}

function ContributionFormBody({ goal }: { goal: GoalRead }) {
  const t = useT();
  const styles = useStyles();
  const lang = useLang();
  const addContribution = useAddContribution(goal.id);

  // F-1: the decimal-pad's separator key is the DEVICE locale's; the shared
  // parser accepts '.' only.
  const resolver: Resolver<ContributionFormInput, unknown, ContributionFormValues> = (
    values,
    context,
    options,
  ) =>
    zodResolver(contributionFormSchema(goal.currency))(
      { ...values, amount: normalizeAmountInput(values.amount) },
      context,
      options,
    );

  const {
    control,
    handleSubmit,
    setError,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<ContributionFormInput, unknown, ContributionFormValues>({
    resolver,
    defaultValues: { amount: '', direction: 'add', occurred_at: todayApiDate(), note: '' },
  });

  const direction = useWatch({ control, name: 'direction' });
  const occurredAt = useWatch({ control, name: 'occurred_at' });
  // Both strings are "YYYY-MM-DD", so a lexicographic compare IS a date compare.
  // A future date is ALLOWED on purpose: it counts toward the saved total
  // immediately, and saying so beats silently rejecting it.
  const isFutureDated = occurredAt > todayApiDate();

  const onSubmit = handleSubmit(async (values) => {
    try {
      await addContribution.mutateAsync({
        amount_minor: signedAmountMinor(values.direction, values.amount),
        occurred_at: values.occurred_at,
        note: emptyToNull(values.note),
      });
      router.back();
    } catch (error) {
      const { field, message } = describeContributionError(error, lang);
      setError(field === 'form' ? 'root' : field === 'amount_minor' ? 'amount' : field, {
        message,
      });
    }
  });

  const pending = isSubmitting || addContribution.isPending;

  return (
    <Shell
      // The goal's NAME is user text, interpolated and never translated.
      title={t('contribution.title', { name: goal.name })}
      footer={<FormButton label={t('common.save')} onPress={onSubmit} pending={pending} />}
    >
      <FieldError message={errors.root?.message} />

      <View style={styles.field}>
        <Text style={styles.label}>{t('contribution.direction')}</Text>
        <View style={styles.chips}>
          <Chip
            label={t('contribution.add')}
            selected={direction === 'add'}
            onPress={() => setValue('direction', 'add')}
          />
          <Chip
            label={t('contribution.withdraw')}
            selected={direction === 'withdraw'}
            onPress={() => setValue('direction', 'withdraw')}
          />
        </View>
      </View>

      <Controller
        control={control}
        name="amount"
        render={({ field }) => (
          <LabeledInput
            // AM-5: parsed with the GOAL's currency, and labelled with it too.
            label={t('contribution.amount', { currency: goal.currency })}
            keyboardType="decimal-pad"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={errors.amount?.message}
          />
        )}
      />

      <Controller
        control={control}
        name="occurred_at"
        render={({ field }) => (
          <DateField
            label={t('common.date')}
            value={field.value}
            onChange={field.onChange}
            hint={isFutureDated ? t('contribution.futureDated') : undefined}
            error={errors.occurred_at?.message}
          />
        )}
      />

      <Controller
        control={control}
        name="note"
        render={({ field }) => (
          <LabeledInput
            label={t('common.noteOptional')}
            multiline
            maxLength={500}
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={errors.note?.message}
            style={styles.noteInput}
          />
        )}
      />
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
  const styles = useStyles();
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
  const styles = useStyles();

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" onPress={() => router.back()} hitSlop={8}>
          <Text style={styles.cancel}>{t('common.cancel')}</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <View style={styles.headerSpacer} />
      </View>
      <KeyboardAwareForm footer={footer}>{children}</KeyboardAwareForm>
    </SafeAreaView>
  );
}

const useStyles = themedStyles((t) => ({
  safe: {
    flex: 1,
    backgroundColor: t.colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: t.spacing.lg,
    paddingVertical: t.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: t.colors.border,
    backgroundColor: t.colors.surface,
  },
  title: {
    flex: 1,
    textAlign: 'center',
    fontSize: t.type.lg,
    fontWeight: '700',
    color: t.colors.text,
  },
  cancel: {
    fontSize: t.type.md,
    color: t.colors.accent,
    minWidth: 60,
  },
  headerSpacer: {
    minWidth: 60,
  },
  field: {
    gap: t.spacing.xs,
  },
  label: {
    fontSize: t.type.sm,
    fontWeight: '600',
    color: t.colors.text,
  },
  notice: {
    color: t.colors.textMuted,
    fontSize: t.type.sm,
  },
  unavailable: {
    color: t.colors.danger,
    fontSize: t.type.md,
  },
  noteInput: {
    minHeight: 80,
    textAlignVertical: 'top',
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: t.spacing.sm,
  },
  chip: {
    minHeight: t.TOUCH_TARGET - 8,
    paddingHorizontal: t.spacing.md,
    paddingVertical: t.spacing.sm,
    borderRadius: t.radius.full,
    borderWidth: 1,
    borderColor: t.colors.border,
    backgroundColor: t.colors.surface,
    justifyContent: 'center',
  },
  // Soft fill plus an ACCENT BORDER — the border is what states the choice on a
  // phone, which has neither hover nor a focus ring to lean on.
  chipSelected: t.selected.chip,
  chipText: {
    fontSize: t.type.sm,
    color: t.colors.text,
  },
  chipTextSelected: t.selected.text,
}));
