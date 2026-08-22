// Language <-> locale, browser detection and the local language cache.
//
// WHY A LOCALE MAP AT ALL: every Intl formatter in the app (dates, months, money,
// counts) takes a LOCALE, while the profile stores a LANGUAGE. Leaving the locale
// undefined means "the host default", which is exactly the shipped defect this
// scope fixes — an English UI printing Russian dates because the OS is ru-RU. One
// map, one direction: the chosen language decides the locale, never the host.
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

/**
 * The language to use when the profile says nothing (`language: null` = the user
 * never chose) and nothing is cached: the browser's own preference order, with
 * English as the final default (PM-1).
 */
export function detectBrowserLang(): Lang {
  if (typeof navigator === 'undefined') return 'en';
  const tags = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const tag of tags) {
    const lang = langFromTag(tag);
    if (lang) return lang;
  }
  return 'en';
}

// --- local cache -----------------------------------------------------------
// Read SYNCHRONOUSLY at bootstrap, before any request: the first paint (login
// screen, offline reload) must already be in the right language, and the profile
// query may never answer at all. Sits next to `budget.auth` in localStorage; the
// try/catch arms cover Safari private mode, where localStorage throws.
const STORAGE_KEY = 'budget.lang';

export function readCachedLang(): Lang | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isLang(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

export function writeCachedLang(lang: Lang): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // A browser that refuses storage still gets a working app — it just
    // re-detects the language on the next load.
  }
}
