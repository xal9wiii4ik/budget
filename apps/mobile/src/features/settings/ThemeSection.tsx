// The theme picker (mobile-design, line A) — the phone's counterpart of web's
// ThemeToggle, built in LanguageSection's shape so the "More" tab reads as one
// list of settings rather than three unrelated controls.
//
// It is NOT a profile setting and sends NO request: the preference lives on the
// device (`src/theme/themeStore.ts`, AsyncStorage, the same `budget.theme` key
// web writes into its own store) because a theme belongs to a screen, not to an
// account — phone dark and desktop light is a normal life. So there is no
// pending state, no error state and no lede about the web app following along:
// a tap applies on the same tick, and the only thing that can fail is the write
// for the NEXT cold start, which the store swallows on purpose.
//
// `system` is offered as a third option rather than being implied by "neither",
// because it is the DEFAULT and a user who has picked light must be able to hand
// the choice back to the OS.
import { Pressable, Text, View } from 'react-native';

import { useT } from '../../i18n/context';
import type { SimpleKey } from '../../i18n/t';
import { themedStyles } from '../../theme/themedStyles';
import type { ThemePreference } from '../../theme/themeStore';
import { useTheme } from '../../theme/useTheme';

// Light | System | Dark, the order web shows them in: the two ends of the scale
// with "let the OS decide" between them.
const OPTIONS: { value: ThemePreference; labelKey: SimpleKey }[] = [
  { value: 'light', labelKey: 'theme.light' },
  { value: 'system', labelKey: 'theme.system' },
  { value: 'dark', labelKey: 'theme.dark' },
];

export function ThemeSection() {
  const styles = useStyles();
  const t = useT();
  const { preference, setPreference } = useTheme();

  return (
    <View style={styles.section}>
      <Text style={styles.title}>{t('theme.label')}</Text>

      <View style={styles.group} accessibilityRole="tablist">
        {OPTIONS.map((option) => {
          const selected = preference === option.value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              onPress={() => setPreference(option.value)}
              style={[styles.option, selected && styles.optionSelected]}
            >
              <Text style={[styles.optionText, selected && styles.optionTextSelected]}>
                {t(option.labelKey)}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
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
  group: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: t.colors.border,
    borderRadius: t.radius.md,
    overflow: 'hidden',
    backgroundColor: t.colors.surface,
  },
  option: {
    flex: 1,
    minHeight: t.TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: t.spacing.sm,
    // In the group's own fill on every option, so turning it accent on the
    // selected one does not move the label by a point (LanguageSection's rule).
    borderWidth: 1,
    borderColor: t.colors.surface,
  },
  optionSelected: t.selected.chip,
  optionText: {
    fontSize: t.type.md,
    fontWeight: '600',
    color: t.colors.text,
  },
  optionTextSelected: {
    color: t.colors.accentSoftFg,
  },
}));
