import { LANGS, type Lang } from '@budget/shared';

import { useUpdateProfile } from '../data/profile';
import { useI18n } from './context';
import styles from './LanguageToggle.module.css';

/** Each name in its OWN language: "Русский" is what a Russian speaker looks for
    even while the UI is English (same rule as the Settings switcher). */
const NATIVE_NAME: Record<Lang, string> = { ru: 'Русский', en: 'English' };

/**
 * The language switcher that lives in the topbar, next to the theme toggle.
 *
 * Same contract as the Settings section it mirrors: `setLang` applies at once and
 * is cached locally, the PATCH publishes the choice to the profile the mobile
 * client reads. A failed PATCH does not roll the UI back — the user asked for
 * this language and got it; only the profile copy is behind.
 */
export function LanguageToggle({ className }: { className?: string }) {
  const { lang, setLang, t } = useI18n();
  const updateProfile = useUpdateProfile();

  const pick = (next: Lang) => {
    if (next === lang) return;
    setLang(next);
    updateProfile.mutate({ language: next });
  };

  return (
    <div
      className={className ? `${styles.group} ${className}` : styles.group}
      role="group"
      aria-label={t('settings.language.label')}
    >
      {LANGS.map((candidate) => (
        <button
          key={candidate}
          type="button"
          className={styles.option}
          aria-pressed={lang === candidate}
          aria-label={NATIVE_NAME[candidate]}
          title={NATIVE_NAME[candidate]}
          onClick={() => pick(candidate)}
        >
          {candidate.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
