// The device's language, for the one moment the profile cannot answer: the login
// screen, and the first frames after a cold start while GET /profile is in flight.
//
// This is the ONLY module that reads expo-localization, and it lives outside
// src/i18n on purpose: the vitest graph is Node-only (docs/mobile.md "Constraints"),
// so no module a test imports may pull in an expo package. i18n/lang.ts stays pure
// and this file is imported by the provider alone.
//
// Note this returns a LANGUAGE, not a locale: the device tag only ever picks which
// language we start in, and the locale then follows THAT choice (i18n/lang.ts).
// Reading the device's own locale for formatting is the defect, not the fallback.
import type { Lang } from '@budget/shared';
import { getLocales } from 'expo-localization';

import { langFromTag } from '../i18n/lang';

/**
 * The device's preferred language we speak, or 'en' as the last resort (the same
 * final default the web client uses). Resolved on demand — the OS language does
 * not change mid-session for our purposes.
 */
export function detectDeviceLang(): Lang {
  for (const locale of getLocales()) {
    const lang = langFromTag(locale.languageTag);
    if (lang) return lang;
  }
  return 'en';
}
