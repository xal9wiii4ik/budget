// The base currency (catch-up 3, line B) — mobile's counterpart of web's
// BaseCurrencySection.
//
// The switch is display-only in its effect (every transaction keeps the amount and
// the rate it was recorded with) but it is NOT harmless: the server CLEARS the
// declared monthly income in the same transaction, because a number stored without
// a currency cannot be re-denominated honestly. So:
//
//   * the three facts are stated as standing copy, above the control, before
//     anything is touched;
//   * every switch goes through a native confirm that names the OLD currency —
//     mobile deviates from web here, which only confirms when an income exists:
//     a chip row has no "are you sure" affordance of its own, and one stray tap
//     next to the one you meant is a much likelier accident with a thumb;
//   * ONE PATCH is sent, after the confirm;
//   * afterwards the old income is converted BY THE SERVER and handed to the
//     income field as an editable suggestion (never saved by this section).
import { formatAmount, todayApiDateUtc } from '@budget/shared';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { confirmAction } from '../../components/confirm';
import { colors, spacing, TOUCH_TARGET } from '../../components/theme';
import { fxConvertQueryOptions } from '../../data/fx';
import { useUpdateProfile, type ProfileRead } from '../../data/profile';
import { useLocale, useT } from '../../i18n/context';
import { currencyOptions } from './currencyOptions';
import type { IncomeHandoff } from './incomeHandoff';

interface BaseCurrencySectionProps {
  profile: ProfileRead;
  /** Called after a CONFIRMED switch, so the income field can prefill. */
  onIncomeHandoff: (handoff: Omit<IncomeHandoff, 'seq'>) => void;
}

export function BaseCurrencySection({ profile, onIncomeHandoff }: BaseCurrencySectionProps) {
  const t = useT();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const updateProfile = useUpdateProfile();
  // Covers the PATCH *and* the follow-up conversion, so the chips stay disabled
  // until the user is actually handed over to the income field.
  const [switching, setSwitching] = useState(false);

  const options = currencyOptions(profile.base_currency);

  const apply = async (next: string) => {
    const previousBase = profile.base_currency;
    const previousIncome = profile.monthly_income_minor;
    setSwitching(true);
    try {
      await updateProfile.mutateAsync({ base_currency: next });
    } catch {
      // The section's own error line says nothing changed; the chips stay as
      // they were, because they render the PROFILE and the profile is unchanged.
      setSwitching(false);
      return;
    }
    // Best effort ON TOP of a switch that already happened: never blocks it, and
    // a failure degrades to an empty field rather than to an invented number.
    const convertedMinor =
      previousIncome === null
        ? null
        : await convertedIncome(queryClient, previousIncome, previousBase, next);
    setSwitching(false);
    onIncomeHandoff({ from: previousBase, convertedMinor });
  };

  const onPick = (next: string) => {
    if (next === profile.base_currency || switching) return;
    confirmAction({
      title: t('settings.baseCurrency.confirmTitle'),
      message:
        profile.monthly_income_minor === null
          ? t('settings.baseCurrency.confirmMessage', {
              from: profile.base_currency,
              to: next,
            })
          : t('settings.baseCurrency.confirmMessageIncome', {
              amount: formatAmount(profile.monthly_income_minor, profile.base_currency, {
                locale,
              }),
              from: profile.base_currency,
              to: next,
            }),
      confirmLabel: t('settings.baseCurrency.confirmSubmit', { to: next }),
      destructive: true,
      onConfirm: () => {
        void apply(next);
      },
    });
  };

  return (
    <View style={styles.section}>
      <Text style={styles.title}>{t('settings.baseCurrency.title')}</Text>
      <Text style={styles.lede}>{t('settings.baseCurrency.lede')}</Text>

      <View style={styles.chips}>
        {options.map((code) => {
          const selected = code === profile.base_currency;
          return (
            <Pressable
              key={code}
              accessibilityRole="button"
              accessibilityState={{ selected, disabled: switching }}
              disabled={switching}
              onPress={() => onPick(code)}
              style={[styles.chip, selected && styles.chipSelected]}
            >
              {/* Bare ISO codes: they are not translated, like the language
                  section's self-named options. */}
              <Text style={[styles.chipText, selected && styles.chipTextSelected]}>
                {code}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {switching ? <Text style={styles.status}>{t('settings.baseCurrency.saving')}</Text> : null}
      {updateProfile.isError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {t('settings.baseCurrency.saveFailed')}
        </Text>
      ) : null}

      <Text style={styles.warning}>{t('settings.baseCurrency.warning')}</Text>
    </View>
  );
}

/**
 * The old income expressed in the new base, or `null` when that cannot be done
 * honestly (no rate for the pair, or the request failed).
 *
 * The conversion is the SERVER's (`GET /fx/convert`) — the client never multiplies
 * by a rate. It goes through `fetchQuery` with the SHARED `fxConvertQueryOptions`,
 * so it lands in the same `['fx','convert', params]` entry the transaction form's
 * preview uses instead of being a second, private way to call the endpoint.
 */
async function convertedIncome(
  queryClient: QueryClient,
  amountMinor: number,
  from: string,
  to: string,
): Promise<number | null> {
  try {
    const preview = await queryClient.fetchQuery(
      fxConvertQueryOptions({
        amountMinor,
        from,
        to,
        // Rates are daily rows the SERVER dates in UTC, so the local calendar day
        // would ask for a row that does not exist yet.
        date: todayApiDateUtc(),
      }),
    );
    return preview.converted_minor;
  } catch {
    // A degraded suggestion is not an error the user has to act on: the field
    // simply opens empty, and the warning already explained why.
    return null;
  }
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
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  chip: {
    minHeight: TOUCH_TARGET - 8,
    minWidth: 64,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: 'center',
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
  status: {
    fontSize: 13,
    color: colors.textMuted,
  },
  error: {
    fontSize: 13,
    color: colors.danger,
  },
  warning: {
    fontSize: 12,
    color: colors.textMuted,
    backgroundColor: colors.card,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
});
