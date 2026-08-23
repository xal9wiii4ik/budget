import { formatAmount, todayApiDateUtc } from '@budget/shared';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useState, type ChangeEvent } from 'react';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { fxConvertQueryOptions } from '../../data/fx';
import { useUpdateProfile, type ProfileRead } from '../../data/profile';
import { useLocale, useT } from '../../i18n/context';
import { currencyOptions } from './currencyOptions';
import type { IncomeHandoff } from './incomeHandoff';
import styles from './SettingsSections.module.css';

interface BaseCurrencySectionProps {
  /** `undefined` while the profile query is loading — the section shows a skeleton. */
  profile: ProfileRead | undefined;
  /** Called after a CONFIRMED switch that cleared a declared income (A1-UX). */
  onIncomeHandoff: (handoff: Omit<IncomeHandoff, 'seq'>) => void;
}

/**
 * The base currency (D1).
 *
 * Two paths, decided by whether a declared income exists:
 *
 *  - income NOT set — instant apply on `change`, exactly like the language
 *    switcher. The warning below the control has already said what changes
 *    (display only, stored snapshots kept, unconvertible rows shown as such), so
 *    a dialog would only repeat standing copy.
 *  - income SET — the switch is destructive: the server clears
 *    `monthly_income_minor` in the same transaction (A1), because a number stored
 *    without a currency cannot be re-denominated honestly. So it goes through
 *    ConfirmDialog BEFORE the PATCH, naming the OLD currency, and afterwards
 *    hands the income field a converted suggestion (Amendment W-A1-UX).
 *
 * On failure the select keeps the value the user picked (LanguageSection's
 * documented reasoning: rolling back would lie about what was asked). On cancel
 * it snaps back, because nothing was asked for.
 */
export function BaseCurrencySection({
  profile,
  onIncomeHandoff,
}: BaseCurrencySectionProps) {
  const t = useT();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const updateProfile = useUpdateProfile();

  // Transient client state: the code the user picked, until the server confirms
  // it (or the user cancels). Not a copy of server data — `profile` stays the
  // truth, and this is `null` in every settled state.
  const [picked, setPicked] = useState<string | null>(null);
  // The pending target of a confirm dialog; `null` = no dialog.
  const [confirming, setConfirming] = useState<string | null>(null);
  // Covers the PATCH *and* the follow-up conversion, so the dialog stays in its
  // pending shape until the user is actually handed over to the income field.
  const [switching, setSwitching] = useState(false);

  const value = picked ?? profile?.base_currency ?? '';
  const options = profile ? currencyOptions(profile.base_currency) : [];
  const disabled = profile === undefined || updateProfile.isPending || switching;

  const onChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value;
    // Guard exactly like the language section: a `change` back to the current
    // value is not a change, and must not produce a PATCH.
    if (!profile || next === profile.base_currency) return;

    setPicked(next);
    if (profile.monthly_income_minor === null) {
      updateProfile.mutate(
        { base_currency: next },
        { onSuccess: () => setPicked(null) },
      );
      return;
    }
    setConfirming(next);
  };

  const confirmSwitch = async (next: string, previous: ProfileRead) => {
    const oldBase = previous.base_currency;
    const oldIncome = previous.monthly_income_minor;
    setSwitching(true);
    try {
      await updateProfile.mutateAsync({ base_currency: next });
    } catch {
      // The dialog stays open with the error below its message; the select keeps
      // the picked value, and nothing was changed server-side.
      setSwitching(false);
      return;
    }

    // Best effort ON TOP of a switch that already happened: never blocks it, and
    // a failure degrades to an empty field rather than to an invented number.
    const convertedMinor =
      oldIncome === null
        ? null
        : await convertedIncome(queryClient, oldIncome, oldBase, next);

    setSwitching(false);
    setConfirming(null);
    setPicked(null);
    onIncomeHandoff({ from: oldBase, convertedMinor });
  };

  return (
    <section className={styles.section}>
      <h2 className={styles.title}>{t('settings.baseCurrency.title')}</h2>
      <p className={styles.lede}>{t('settings.baseCurrency.lede')}</p>

      <div className={styles.row}>
        <label className={styles.label} htmlFor="settings-base-currency">
          {t('settings.baseCurrency.label')}
        </label>
        <select
          id="settings-base-currency"
          className={styles.select}
          value={value}
          onChange={onChange}
          disabled={disabled}
        >
          {profile ? (
            options.map((code) => (
              // Bare ISO codes (OQ-3): they are not translated, like the language
              // section's self-named options.
              <option key={code} value={code}>
                {code}
              </option>
            ))
          ) : (
            <option value="">{t('common.loading')}</option>
          )}
        </select>
        {updateProfile.isPending || switching ? (
          <span className={styles.status}>{t('settings.baseCurrency.saving')}</span>
        ) : null}
      </div>

      {updateProfile.isError && confirming === null ? (
        <p className={styles.error} role="alert">
          {t('settings.baseCurrency.saveFailed')}
        </p>
      ) : null}

      <p className={styles.warning}>{t('settings.baseCurrency.warning')}</p>

      {confirming !== null && profile ? (
        <ConfirmDialog
          title={t('settings.baseCurrency.confirmTitle')}
          message={t('settings.baseCurrency.confirmMessage', {
            amount: formatIncome(profile, locale),
            from: profile.base_currency,
            to: confirming,
          })}
          confirmLabel={t('settings.baseCurrency.confirmSubmit', { to: confirming })}
          pendingLabel={t('settings.baseCurrency.confirmPending')}
          destructive
          isPending={switching}
          errorMessage={
            updateProfile.isError ? t('settings.baseCurrency.saveFailed') : undefined
          }
          onConfirm={() => {
            void confirmSwitch(confirming, profile);
          }}
          onCancel={() => {
            setConfirming(null);
            setPicked(null);
            updateProfile.reset();
          }}
        />
      ) : null}
    </section>
  );
}

/**
 * The old income expressed in the new base, or `null` when that cannot be done
 * honestly (no rate for the pair, or the request failed).
 *
 * The conversion is the SERVER's (`GET /fx/convert`) — the client never
 * multiplies by a rate. It goes through `queryClient.fetchQuery` with the shared
 * `fxConvertQueryOptions`, so it lands in the same `['fx','convert', params]`
 * entry the transaction form's preview uses, rather than being a second, private
 * way to call the endpoint.
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
        // would ask for a row that does not exist yet (docs/web.md).
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

/**
 * The declared income as text, for the confirm dialog's "you declared X" clause.
 *
 * `formatAmount`, not `formatMoney`: the copy names the currency CODE right after
 * the number (the whole point of the dialog is which currency the number was
 * meant in), and a symbol in front of that code would say it twice.
 */
function formatIncome(profile: ProfileRead, locale: string): string {
  // Only reachable from the arm where an income exists; `?? 0` is not a fallback
  // the user can see, it is what keeps this free of a non-null assertion.
  return formatAmount(profile.monthly_income_minor ?? 0, profile.base_currency, {
    locale,
  });
}
