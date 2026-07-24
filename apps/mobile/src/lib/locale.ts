// Explicit locale for the shared money/date helpers (plan §H, R2). Hermes'
// host-default locale is unreliable on some Android OEM configs, so we pass an
// explicit locale sourced from expo-localization rather than relying on the default.
// Resolved once at module load (the device locale doesn't change mid-session for
// our purposes).
import { getLocales } from 'expo-localization';

function resolveLocale(): string {
  const locales = getLocales();
  return locales[0]?.languageTag ?? 'en-US';
}

export const APP_LOCALE = resolveLocale();
