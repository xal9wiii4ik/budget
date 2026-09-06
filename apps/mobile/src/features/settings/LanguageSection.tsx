// The interface-language picker (catch-up 3, line B) — mobile's counterpart of
// web's Settings LanguageSection / topbar LanguageToggle.
//
// Mobile has NO local language cache (there is no synchronous store to read at
// bootstrap), so unlike web there is no "applies here even if the PATCH fails"
// state to keep: the profile IS the choice. The PATCH response seeds `['profile']`
// (data/profile.ts), I18nProvider derives `lang` from that very query during
// render, and the app is in the new language on the same tick — no cold restart,
// which closes the gap `docs/mobile.md` recorded for mobile-catchup-1.
//
// The two option labels are each written in their OWN language and are therefore
// NOT translated: "Русский" is what a Russian speaker looks for while the UI is
// still English.
import { LANGS, type Lang } from '@budget/shared';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, spacing, TOUCH_TARGET } from '../../components/theme';
import { useUpdateProfile } from '../../data/profile';
import { useLang, useT } from '../../i18n/context';

const NATIVE_NAME: Record<Lang, string> = { ru: 'Русский', en: 'English' };

export function LanguageSection() {
  const t = useT();
  const lang = useLang();
  const updateProfile = useUpdateProfile();

  const pick = (next: Lang) => {
    // A tap on the language already in use is not a change, and must not PATCH.
    if (next === lang || updateProfile.isPending) return;
    updateProfile.mutate({ language: next });
  };

  return (
    <View style={styles.section}>
      <Text style={styles.title}>{t('settings.language.title')}</Text>
      <Text style={styles.lede}>{t('settings.language.lede')}</Text>

      <View style={styles.group} accessibilityRole="tablist">
        {LANGS.map((candidate) => {
          const selected = lang === candidate;
          return (
            <Pressable
              key={candidate}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              accessibilityLabel={NATIVE_NAME[candidate]}
              disabled={updateProfile.isPending}
              onPress={() => pick(candidate)}
              style={[styles.option, selected && styles.optionSelected]}
            >
              <Text style={[styles.optionText, selected && styles.optionTextSelected]}>
                {NATIVE_NAME[candidate]}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {updateProfile.isPending ? (
        <Text style={styles.status}>{t('settings.language.saving')}</Text>
      ) : null}
      {updateProfile.isError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {t('settings.language.saveFailed')}
        </Text>
      ) : null}
    </View>
  );
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
  group: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: colors.card,
  },
  option: {
    flex: 1,
    minHeight: TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
  },
  optionSelected: {
    backgroundColor: colors.primary,
  },
  optionText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text,
  },
  optionTextSelected: {
    color: '#FFFFFF',
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
