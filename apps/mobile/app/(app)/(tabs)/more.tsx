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
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Card } from '../../../src/components/Card';
import { EmptyState } from '../../../src/components/EmptyState';
import { FormButton } from '../../../src/components/FormButton';
import { KeyboardAwareForm } from '../../../src/components/KeyboardAwareForm';
import { useProfile } from '../../../src/data/profile';
import { BaseCurrencySection } from '../../../src/features/settings/BaseCurrencySection';
import type { IncomeHandoff } from '../../../src/features/settings/incomeHandoff';
import { LanguageSection } from '../../../src/features/settings/LanguageSection';
import { MonthlyIncomeSection } from '../../../src/features/settings/MonthlyIncomeSection';
import { ThemeSection } from '../../../src/features/settings/ThemeSection';
import { useT } from '../../../src/i18n/context';
import { themedStyles } from '../../../src/theme/themedStyles';

export default function MoreScreen() {
  const styles = useStyles();
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
        {/* The navigation rows are ONE card that pads its own rows (the list
            rule), so the next destination added here joins it behind a hairline
            instead of becoming a second floating box. */}
        <Card padding="none">
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
        </Card>

        {/* The language does NOT wait for the profile: it is already resolved for
            the whole app (I18nProvider), and the picker writes it rather than
            reading it back. */}
        <LanguageSection />

        {/* Next to the language because it is the other setting that changes how
            the app LOOKS rather than what it counts — and, like the language, it
            does not wait for the profile: the theme lives on the device. */}
        <ThemeSection />

        {profileQuery.isPending ? (
          <Text style={styles.notice}>{t('common.loading')}</Text>
        ) : profileQuery.isError || profileQuery.data === undefined ? (
          <EmptyState
            role="alert"
            title={t('settings.baseCurrency.loadFailed')}
            action={
              <FormButton
                label={t('common.retry')}
                variant="secondary"
                onPress={() => profileQuery.refetch()}
              />
            }
          />
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

const useStyles = themedStyles((t) => ({
  safe: {
    flex: 1,
    backgroundColor: t.colors.bg,
  },
  // The card owns the surface and the border now; the row owns its padding.
  navRow: {
    minHeight: t.TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.md,
    paddingHorizontal: t.spacing.md,
    paddingVertical: t.spacing.md,
  },
  navIcon: {
    fontSize: t.type.xl,
  },
  navText: {
    flex: 1,
    gap: 2,
  },
  navLabel: {
    fontSize: t.type.lg,
    fontWeight: '600',
    color: t.colors.text,
  },
  navHint: {
    fontSize: t.type.xs,
    color: t.colors.textMuted,
  },
  navChevron: {
    fontSize: t.type.xl,
    color: t.colors.textMuted,
  },
  notice: {
    fontSize: t.type.sm,
    color: t.colors.textMuted,
  },
}));
