import type { Lang } from '@budget/shared';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { useProfile } from '../data/profile';
import { I18nContext, type I18nValue } from './context';
import { detectBrowserLang, localeFor, readCachedLang, writeCachedLang } from './lang';
import { createTranslate } from './t';

/**
 * Resolves ONE language for the whole app and provides `t` / `lang` / `locale`.
 *
 * Precedence, highest first:
 *   1. `chosen`  — an explicit pick made in this tab. It wins even over the
 *      profile, because the PATCH may still be in flight or may have failed: the
 *      user asked for this language and the UI must not flip back under them.
 *   2. `profile.language` — the shared, cross-device truth (also written by the
 *      mobile client). `null` there means "never chose" and is skipped, NOT
 *      treated as a language.
 *   3. the local cache (`budget.lang`), read SYNCHRONOUSLY at bootstrap so the
 *      login screen and an offline reload are already in the right language.
 *   4. the browser's preference, English as the last resort (PM-1).
 *
 * Everything above is DERIVED during render — no effect mirrors server state into
 * component state. The one effect here is a genuine external write (localStorage
 * + `<html lang>`), not a sync.
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  // Read once, at mount: this is a bootstrap value, not a subscription.
  const [bootstrap] = useState<Lang>(() => readCachedLang() ?? detectBrowserLang());
  const [chosen, setChosen] = useState<Lang | undefined>(undefined);

  // Disabled while logged out; while it loads (or 404s until the backend line of
  // this scope ships `/profile`), the bootstrap language is already on screen.
  const profileQuery = useProfile();
  const lang = chosen ?? profileQuery.data?.language ?? bootstrap;

  useEffect(() => {
    writeCachedLang(lang);
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = useCallback((next: Lang) => setChosen(next), []);

  const value = useMemo<I18nValue>(
    () => ({ lang, locale: localeFor(lang), t: createTranslate(lang), setLang }),
    [lang, setLang],
  );

  return <I18nContext value={value}>{children}</I18nContext>;
}
