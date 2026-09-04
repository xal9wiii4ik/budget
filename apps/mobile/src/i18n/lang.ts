// Language <-> locale. COPY of the pure half of web's src/i18n/lang.ts.
//
// WHY A LOCALE MAP AT ALL: every Intl formatter in the app (dates, months, money,
// counts) takes a LOCALE, while the profile stores a LANGUAGE. Leaving the locale
// to the host means "the device default", which is exactly the defect this scope
// fixes on mobile — an English UI printing Russian dates because the phone is set
// to ru-RU. One map, one direction: the chosen language decides the locale, never
// the device.
//
// What is deliberately NOT copied from web: `readCachedLang`/`writeCachedLang`.
// Mobile has no synchronous store to read at bootstrap (AsyncStorage/SecureStore
// are async, and tokens are the only thing that may live in the keychain), so
// there is nothing to cache into — the login screen follows the device instead.
// This file therefore stays pure and platform-free; device detection lives in
// ../lib/deviceLang.ts, which nothing under test imports.
import { isLang, type Lang } from '@budget/shared';

export const LOCALE_BY_LANG: Record<Lang, string> = {
  ru: 'ru-RU',
  en: 'en-US',
};

export function localeFor(lang: Lang): string {
  return LOCALE_BY_LANG[lang];
}

/** "ru-RU" / "RU" / "ru" -> 'ru'; anything we do not speak -> undefined. */
export function langFromTag(tag: string | null | undefined): Lang | undefined {
  if (!tag) return undefined;
  const primary = tag.toLowerCase().split('-')[0];
  return isLang(primary) ? primary : undefined;
}
