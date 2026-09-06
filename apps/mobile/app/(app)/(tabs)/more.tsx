// The "More" tab (catch-up 3, line B) — everything that is neither a list of money
// nor a form for one: the way into recurring templates, and the three profile
// settings the app runs on (language, base currency, declared monthly income).
//
// It is a TAB rather than a header button because two of the three settings change
// what every other screen SHOWS (the language, and the currency the totals are
// summed in), so they need a destination of their own that is always reachable.
// Log out stays in the header, where it has always been — moving it here would
// hide it behind a tab on every screen that has one.
//
// ONE profile query feeds all three sections, so a failed read is ONE notice and
// not three competing ones.
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FormButton } from '../../../src/components/FormButton';
import { KeyboardAwareForm } from '../../../src/components/KeyboardAwareForm';
import { colors, spacing, TOUCH_TARGET } from '../../../src/components/theme';
import { useProfile } from '../../../src/data/profile';
import { BaseCurrencySection } from '../../../src/features/settings/BaseCurrencySection';
import type { IncomeHandoff } from '../../../src/features/settings/incomeHandoff';
import { LanguageSection } from '../../../src/features/settings/LanguageSection';
import { MonthlyIncomeSection } from '../../../src/features/settings/MonthlyIncomeSection';
import { useT } from '../../../src/i18n/context';

export default function MoreScreen() {
  const t = useT();
  const profileQuery = useProfile();

  // The base-currency switch clears the declared income server-side, so it hands
  // the income field a converted suggestion. Genuine client state: an UNSAVED
  // draft, deliberately not in the Query cache. `seq` makes two switches in a row
  // two distinct handovers.
  const [handoff, setHandoff] = useState<IncomeHandoff | null>(null);

  return (
    // The income field is a text input, so this screen scrolls with the keyboard
    // like every form does; the tab bar owns the bottom inset above it.
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <KeyboardAwareForm>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.push('/recurring')}
          style={styles.navRow}
        >
          <Text style={styles.navIcon}>🔁</Text>
          <View style={styles.navText}>
            <Text style={styles.navLabel}>{t('more.recurring')}</Text>
            <Text style={styles.navHint}>{t('more.recurringHint')}</Text>
          </View>
          <Text style={styles.navChevron}>›</Text>
        </Pressable>

        {/* The language does NOT wait for the profile: it is already resolved for
            the whole app (I18nProvider), and the picker writes it rather than
            reading it back. */}
        <LanguageSection />

        {profileQuery.isPending ? (
          <Text style={styles.notice}>{t('common.loading')}</Text>
        ) : profileQuery.isError || profileQuery.data === undefined ? (
          <View style={styles.stateBox}>
            <Text accessibilityRole="alert" style={styles.error}>
              {t('settings.baseCurrency.loadFailed')}
            </Text>
            <FormButton
              label={t('common.retry')}
              variant="secondary"
              onPress={() => profileQuery.refetch()}
            />
          </View>
        ) : (
          <>
            <BaseCurrencySection
              profile={profileQuery.data}
              onIncomeHandoff={(next) =>
                setHandoff((previous) => ({ ...next, seq: (previous?.seq ?? 0) + 1 }))
              }
            />
            <MonthlyIncomeSection
              profile={profileQuery.data}
              handoff={handoff}
              onHandoffConsumed={() => setHandoff(null)}
            />
          </>
        )}
      </KeyboardAwareForm>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  navRow: {
    minHeight: TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  navIcon: {
    fontSize: 20,
  },
  navText: {
    flex: 1,
    gap: 2,
  },
  navLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
  },
  navHint: {
    fontSize: 12,
    color: colors.textMuted,
  },
  navChevron: {
    fontSize: 22,
    color: colors.textMuted,
  },
  notice: {
    fontSize: 14,
    color: colors.textMuted,
  },
  stateBox: {
    gap: spacing.md,
  },
  error: {
    fontSize: 14,
    color: colors.danger,
  },
});
