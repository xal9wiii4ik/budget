// The declared monthly income (catch-up 3, line B) — mobile's counterpart of web's
// MonthlyIncomeSection.
//
// Deliberately NOT instant-apply like the two pickers above it: a free-text money
// field has no "committed" moment other than an explicit Save, and auto-saving a
// half-typed amount is exactly how a "12" gets stored on the way to "12000".
// Clearing the field and saving stores `null` — "I am not declaring an income".
//
// The form below is REMOUNTED by `key` whenever its baseline changes (a save, a
// base switch, an arriving suggestion). That is how the field takes its value from
// server data without a single state-syncing effect: React rebuilds it from the
// new baseline, while the saved/failed status survives because it belongs to the
// mutation, not to the form.
import { formatMoney, type Lang } from '@budget/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMemo } from 'react';
import { Controller, useForm, type Resolver } from 'react-hook-form';
import { StyleSheet, Text, View } from 'react-native';

import { FormButton } from '../../components/FormButton';
import { LabeledInput } from '../../components/LabeledInput';
import { colors, spacing } from '../../components/theme';
import { useUpdateProfile, type ProfileRead } from '../../data/profile';
import { useLang, useLocale, useT } from '../../i18n/context';
import type { Translate } from '../../i18n/t';
import { normalizeAmountInput, toLocalInputString } from '../../lib/amountInput';
import {
  incomeFormSchema,
  type IncomeFormInput,
  type IncomeFormValues,
} from './incomeFormSchema';
import type { IncomeHandoff } from './incomeHandoff';

interface MonthlyIncomeSectionProps {
  profile: ProfileRead;
  /** A converted suggestion from a just-confirmed base switch, if any. */
  handoff: IncomeHandoff | null;
  /**
   * The handoff is spent once the user saves: the stored value becomes the
   * baseline again, and a suggestion that outlived its save would re-prefill the
   * OLD converted number over the one just typed.
   */
  onHandoffConsumed: () => void;
}

export function MonthlyIncomeSection({
  profile,
  handoff,
  onHandoffConsumed,
}: MonthlyIncomeSectionProps) {
  const t = useT();
  const locale = useLocale();
  const updateProfile = useUpdateProfile();

  return (
    <View style={styles.section}>
      <Text style={styles.title}>{t('settings.income.title')}</Text>
      <Text style={styles.lede}>{t('settings.income.lede')}</Text>

      <IncomeForm
        // Remounting on ANY of these is the point: each one means "the field's
        // baseline is a different number now". `seq` covers two switches in a
        // row, which would otherwise produce the same key twice.
        key={`${profile.base_currency}:${profile.monthly_income_minor ?? 'none'}:${handoff?.seq ?? 0}`}
        currency={profile.base_currency}
        baselineMinor={profile.monthly_income_minor}
        suggestedMinor={handoff?.convertedMinor ?? null}
        isPending={updateProfile.isPending}
        onSave={async (income) => {
          await updateProfile.mutateAsync({ monthly_income_minor: income });
          onHandoffConsumed();
        }}
        t={t}
      />

      <Text style={styles.note}>
        {t('settings.income.baseNote', { currency: profile.base_currency })}
      </Text>
      <Text style={styles.note}>{t('settings.income.clearHint')}</Text>

      {handoff ? (
        <Text style={styles.suggestion}>
          {handoff.convertedMinor === null
            ? t('settings.income.suggestionUnavailable', { currency: profile.base_currency })
            : t('settings.income.suggestion', {
                amount: formatMoney(handoff.convertedMinor, profile.base_currency, { locale }),
                from: handoff.from,
              })}
        </Text>
      ) : null}

      {updateProfile.isSuccess ? (
        <Text style={styles.status}>{t('settings.income.saved')}</Text>
      ) : null}
      {updateProfile.isError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {t('settings.income.saveFailed')}
        </Text>
      ) : null}
    </View>
  );
}

interface IncomeFormProps {
  currency: string;
  /** What the server currently stores — the diff baseline (patch discipline). */
  baselineMinor: number | null;
  /** A converted draft to open with, in MINOR units of `currency`. */
  suggestedMinor: number | null;
  isPending: boolean;
  onSave: (income: number | null) => Promise<void>;
  t: Translate;
}

function IncomeForm({
  currency,
  baselineMinor,
  suggestedMinor,
  isPending,
  onSave,
  t,
}: IncomeFormProps) {
  const lang = useLang();
  // The currency decides how many decimals are legal, so the resolver is rebuilt
  // when it changes. F-1: the typed value is normalized on the way in, because a
  // ru decimal-pad can only emit ','.
  const resolver = useMemo<Resolver<IncomeFormInput, unknown, IncomeFormValues>>(
    () => (values, context, options) =>
      zodResolver(incomeFormSchema(currency, t))(
        { income: normalizeAmountInput(values.income) },
        context,
        options,
      ),
    [currency, t],
  );

  const {
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<IncomeFormInput, unknown, IncomeFormValues>({
    resolver,
    // The suggestion wins over the stored value: it only ever exists right after
    // a base switch, where the stored value is `null` by design. Either way it is
    // an ordinary editable default — nothing is saved until Save is pressed.
    defaultValues: { income: prefill(suggestedMinor ?? baselineMinor, currency, lang) },
  });

  const onSubmit = handleSubmit(async (values) => {
    // Patch discipline: a submit that changes nothing sends nothing.
    if (values.income === baselineMinor) return;
    try {
      await onSave(values.income);
    } catch {
      // Surfaced by the section's mutation state (the alert below the form).
    }
  });

  const pending = isPending || isSubmitting;

  return (
    <View style={styles.form}>
      <Controller
        control={control}
        name="income"
        render={({ field }) => (
          <LabeledInput
            label={`${t('settings.income.label')}, ${currency}`}
            keyboardType="decimal-pad"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={errors.income?.message}
          />
        )}
      />
      <FormButton
        label={t(pending ? 'settings.income.saving' : 'settings.income.save')}
        onPress={onSubmit}
        pending={pending}
      />
    </View>
  );
}

/** Minor units -> the string the field edits; `null` -> an empty field. */
function prefill(minor: number | null, currency: string, lang: Lang): string {
  return minor === null ? '' : toLocalInputString(minor, currency, lang);
}

const styles = StyleSheet.create({
  section: {
    gap: spacing.sm,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.text,
  },
  lede: {
    fontSize: 13,
    color: colors.textMuted,
  },
  form: {
    gap: spacing.sm,
  },
  note: {
    fontSize: 12,
    color: colors.textMuted,
  },
  suggestion: {
    fontSize: 13,
    color: colors.primary,
  },
  status: {
    fontSize: 13,
    color: colors.textMuted,
  },
  error: {
    fontSize: 13,
    color: colors.danger,
  },
});
