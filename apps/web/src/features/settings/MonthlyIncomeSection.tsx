import { formatMoney, toInputString } from '@budget/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMemo } from 'react';
import { useForm } from 'react-hook-form';

import { useUpdateProfile, type ProfileRead } from '../../data/profile';
import { useLocale, useT } from '../../i18n/context';
import type { Translate } from '../../i18n/t';
import {
  incomeFormSchema,
  type IncomeFormInput,
  type IncomeFormValues,
} from './incomeFormSchema';
import type { IncomeHandoff } from './incomeHandoff';
import styles from './SettingsSections.module.css';

interface MonthlyIncomeSectionProps {
  /** `undefined` while the profile query is loading — the row shows a skeleton. */
  profile: ProfileRead | undefined;
  /** A converted suggestion from a just-confirmed base switch (A1-UX), if any. */
  handoff: IncomeHandoff | null;
  /** `/goals` deep link (`?focus=income`) asked for this field. */
  deepLinkFocus: boolean;
  /**
   * The handoff is spent once the user saves: the stored value becomes the
   * baseline again, and a suggestion that outlived its save would re-prefill the
   * OLD converted number over the one the user just typed.
   */
  onHandoffConsumed: () => void;
}

/**
 * The declared monthly income (D2) — the ONE write surface for it (OQ-4); the
 * goals screen deep-links here rather than growing a second one.
 *
 * Deliberately NOT instant-apply like the two selects: a free-text money field
 * has no "committed" moment other than a submit, and auto-saving a half-typed
 * amount is exactly how a "12" gets stored on the way to "12000".
 *
 * The mutation lives HERE and the form below it is remounted by `key` whenever
 * its baseline changes (a save, a base switch, an arriving suggestion). That is
 * how the field gets its value from server data without a single
 * state-syncing `useEffect`: React rebuilds the form from the new baseline, and
 * the "saved"/"failed" status survives because it belongs to the mutation, not
 * to the form.
 */
export function MonthlyIncomeSection({
  profile,
  handoff,
  deepLinkFocus,
  onHandoffConsumed,
}: MonthlyIncomeSectionProps) {
  const t = useT();
  const locale = useLocale();
  const updateProfile = useUpdateProfile();

  return (
    <section className={styles.section} id="settings-income">
      <h2 className={styles.title}>{t('settings.income.title')}</h2>
      <p className={styles.lede}>{t('settings.income.lede')}</p>

      {profile === undefined ? (
        <div className={styles.row}>
          <span className={styles.label}>{t('settings.income.label')}</span>
          <div className={styles.skeletonControl} aria-hidden="true" />
        </div>
      ) : (
        <IncomeForm
          // Remounting on ANY of these is the point: each one means "the field's
          // baseline is a different number now". `seq` covers two switches in a
          // row, which would otherwise produce the same key twice.
          key={`${profile.base_currency}:${profile.monthly_income_minor ?? 'none'}:${handoff?.seq ?? 0}`}
          currency={profile.base_currency}
          baselineMinor={profile.monthly_income_minor}
          suggestedMinor={handoff?.convertedMinor ?? null}
          // The field is focused on arrival from `/goals` and after a base switch
          // — both are a handover, not a page the user chose to type on.
          focusOnMount={deepLinkFocus || handoff !== null}
          isPending={updateProfile.isPending}
          onSave={async (income) => {
            await updateProfile.mutateAsync({ monthly_income_minor: income });
            onHandoffConsumed();
          }}
          onEdit={() => {
            // The status line describes the LAST save; the moment the user types
            // again it describes nothing.
            if (updateProfile.isSuccess || updateProfile.isError) updateProfile.reset();
          }}
          t={t}
        />
      )}

      {profile ? (
        <p className={styles.note}>
          {t('settings.income.baseNote', { currency: profile.base_currency })}
        </p>
      ) : null}
      <p className={styles.note}>{t('settings.income.clearHint')}</p>

      {handoff && profile ? (
        <p className={styles.suggestion}>
          {handoff.convertedMinor === null
            ? t('settings.income.suggestionUnavailable', {
                currency: profile.base_currency,
              })
            : t('settings.income.suggestion', {
                amount: formatMoney(handoff.convertedMinor, profile.base_currency, {
                  locale,
                }),
                from: handoff.from,
              })}
        </p>
      ) : null}

      {updateProfile.isSuccess ? (
        <p className={styles.status} role="status">
          {t('settings.income.saved')}
        </p>
      ) : null}
      {updateProfile.isError ? (
        <p className={styles.error} role="alert">
          {t('settings.income.saveFailed')}
        </p>
      ) : null}
    </section>
  );
}

/** Minor units -> the machine string the field edits; `null` -> an empty field. */
function prefill(minor: number | null, currency: string): string {
  return minor === null ? '' : toInputString(minor, currency);
}

interface IncomeFormProps {
  currency: string;
  /** What the server currently stores — the diff baseline (patch discipline). */
  baselineMinor: number | null;
  /** A converted draft to open with, in MINOR units of `currency`. */
  suggestedMinor: number | null;
  focusOnMount: boolean;
  isPending: boolean;
  onSave: (income: number | null) => Promise<void>;
  onEdit: () => void;
  t: Translate;
}

function IncomeForm({
  currency,
  baselineMinor,
  suggestedMinor,
  focusOnMount,
  isPending,
  onSave,
  onEdit,
  t,
}: IncomeFormProps) {
  // The currency decides how many decimals are legal, so the resolver is rebuilt
  // when it changes (all four supported currencies have exponent 2 today — the
  // factory is what keeps that from being an assumption).
  const resolver = useMemo(() => zodResolver(incomeFormSchema(currency, t)), [currency, t]);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<IncomeFormInput, unknown, IncomeFormValues>({
    resolver,
    // The suggestion wins over the stored value: it only ever exists right after
    // a base switch, where the stored value is `null` by design. Either way it is
    // an ordinary editable default — nothing is saved until Save is pressed.
    defaultValues: { income: prefill(suggestedMinor ?? baselineMinor, currency) },
  });

  const onSubmit = handleSubmit(async (values) => {
    // Patch-builder discipline: a submit that changes nothing sends nothing.
    if (values.income === baselineMinor) return;
    try {
      await onSave(values.income);
    } catch {
      // Surfaced by the section's mutation state (role="alert" below the form).
    }
  });

  const pending = isPending || isSubmitting;

  return (
    <form onSubmit={onSubmit} noValidate>
      <div className={styles.row}>
        <label className={styles.label} htmlFor="settings-income-input">
          {t('settings.income.label')}
        </label>
        <input
          id="settings-income-input"
          inputMode="decimal"
          autoComplete="off"
          className={errors.income ? `${styles.input} ${styles.inputError}` : styles.input}
          aria-invalid={errors.income ? true : undefined}
          disabled={pending}
          // Autofocus is a deliberate HANDOVER here (a `/goals` deep link or a
          // just-confirmed base switch), never the default landing state of the
          // settings page: `focusOnMount` is false on a plain visit.
          autoFocus={focusOnMount}
          {...register('income', { onChange: onEdit })}
        />
        <span className={styles.currency}>{currency}</span>
        <button type="submit" className={styles.submit} disabled={pending}>
          {pending ? t('settings.income.saving') : t('settings.income.save')}
        </button>
      </div>
      {errors.income?.message ? (
        <p className={styles.error} role="alert">
          {errors.income.message}
        </p>
      ) : null}
    </form>
  );
}
