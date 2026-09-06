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
import { Pressable, Text, View } from 'react-native';

import { confirmAction } from '../../components/confirm';
import { themedStyles } from '../../theme/themedStyles';
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
  const styles = useStyles();
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
      cancelLabel: t('common.cancel'),
      title: t('settings.baseCurrency.confirmTitle'),
      // The only amount this section prints goes into a NATIVE alert, which
      // takes a string and no style — so there is no `tnum` to spread on it
      // (nothing here renders money into a <Text> of ours).
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

const useStyles = themedStyles((t) => ({
  section: {
    gap: t.spacing.sm,
  },
  title: {
    fontSize: t.type.lg,
    fontWeight: '700',
    color: t.colors.text,
  },
  lede: {
    fontSize: t.type.sm,
    color: t.colors.textMuted,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: t.spacing.sm,
  },
  chip: {
    minHeight: t.TOUCH_TARGET - 8,
    minWidth: 64,
    paddingHorizontal: t.spacing.md,
    paddingVertical: t.spacing.sm,
    borderRadius: t.radius.full,
    borderWidth: 1,
    borderColor: t.colors.border,
    backgroundColor: t.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipSelected: t.selected.chip,
  chipText: {
    fontSize: t.type.sm,
    color: t.colors.text,
  },
  chipTextSelected: t.selected.text,
  status: {
    fontSize: t.type.sm,
    color: t.colors.textMuted,
  },
  error: {
    fontSize: t.type.sm,
    color: t.colors.danger,
  },
  // It states what a switch costs BEFORE it is tapped, so it is a warning, not
  // an expense: the `warning` pair, never the money colour it used to borrow.
  warning: {
    fontSize: t.type.xs,
    color: t.colors.warningSoftFg,
    backgroundColor: t.colors.warningSoft,
    borderRadius: t.radius.md,
    padding: t.spacing.md,
  },
}));
