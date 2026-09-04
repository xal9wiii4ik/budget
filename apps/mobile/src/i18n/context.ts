// The i18n context and its hooks. COPY of web's src/i18n/context.ts, minus
// `setLang`: mobile has no language picker (the language is chosen in the web
// settings screen and arrives on the profile), so there is no explicit choice for
// this layer to record.
//
// Split from I18nProvider.tsx so the provider file exports a component and nothing
// else. Screens depend on THIS surface — `useT()`, `useLang()`, `useLocale()` —
// and never on the dictionaries or on `translate` directly, so the implementation
// underneath can be replaced wholesale without touching a screen.
import type { Lang } from '@budget/shared';
import { createContext, use } from 'react';

import { localeFor } from './lang';
import { createTranslate, type Translate } from './t';

export interface I18nValue {
  lang: Lang;
  /** The Intl locale for `lang` — pass it to every formatter (dates, money). */
  locale: string;
  t: Translate;
}

// The default value is a real, working English translator rather than `null`: a
// component rendered outside the provider (a screen mounted in isolation) shows
// English copy instead of crashing.
const FALLBACK: I18nValue = {
  lang: 'en',
  locale: localeFor('en'),
  t: createTranslate('en'),
};

export const I18nContext = createContext<I18nValue>(FALLBACK);

export function useI18n(): I18nValue {
  return use(I18nContext);
}

export function useT(): Translate {
  return use(I18nContext).t;
}

export function useLang(): Lang {
  return use(I18nContext).lang;
}

/** The locale string for every Intl-based helper (`formatApiDate`, `formatMoney`). */
export function useLocale(): string {
  return use(I18nContext).locale;
}
