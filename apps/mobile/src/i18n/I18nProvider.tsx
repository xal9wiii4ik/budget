import { useMemo, useState, type ReactNode } from 'react';
import type { Lang } from '@budget/shared';

import { useProfile } from '../data/profile';
import { detectDeviceLang } from '../lib/deviceLang';
import { I18nContext, type I18nValue } from './context';
import { localeFor } from './lang';
import { createTranslate } from './t';

/**
 * Resolves ONE language for the whole app and provides `t` / `lang` / `locale`.
 *
 * Precedence, highest first:
 *   1. `profile.language` — the shared, cross-device truth, written on the web
 *      settings screen. `null` there means "never chose" and is SKIPPED, not
 *      treated as a language.
 *   2. the DEVICE language, English as the last resort (the same final default
 *      web falls back to).
 *
 * Two things web has and this deliberately does not:
 *   * a `chosen` state — there is no language picker on mobile, so there is no
 *     explicit choice that could outrank the profile;
 *   * a local cache — mobile has no synchronous store to read at bootstrap, so
 *     the pre-login language is simply the device's. A returning user sees the
 *     device language for the frames before GET /profile answers, and the copy
 *     on screen then (login form, splash-adjacent) is either device-correct or
 *     replaced within one request.
 *
 * The language is DERIVED during render — no effect mirrors server state into
 * component state — and there is no external write (no `<html lang>` here, and no
 * storage), so this provider holds no effect at all.
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  // Read once, at mount: a bootstrap value, not a subscription. The OS language
  // does not change under a running app for our purposes, and reading it through
  // a lazy initializer keeps the native call off every render.
  const [deviceLang] = useState<Lang>(detectDeviceLang);

  // Disabled while logged out (data/profile.ts); while it loads, the device
  // language is already on screen.
  const profileQuery = useProfile();
  const lang: Lang = profileQuery.data?.language ?? deviceLang;

  const value = useMemo<I18nValue>(
    () => ({ lang, locale: localeFor(lang), t: createTranslate(lang) }),
    [lang],
  );

  return <I18nContext value={value}>{children}</I18nContext>;
}
