// The translator: dictionary lookup + `{name}` interpolation + CLDR plurals.
//
// PURE AND PLATFORM-FREE (no React, no DOM): the provider binds it to the current
// language and hands components `t`, so a screen never knows whether the strings
// come from these objects or, one day, from i18next — swapping the implementation
// would not touch a single call site.
//
// Numbers are interpolated through `Intl.NumberFormat` of the CHOSEN language's
// locale (1234 -> "1,234" in en, "1 234" in ru), for the same reason dates take a
// locale: the host's locale is not the user's choice.
import type { Lang } from '@budget/shared';

import { en } from './dict.en';
import { ru } from './dict.ru';
import { localeFor } from './lang';
import type { PluralForms } from './types';

type EnDict = typeof en;

/** Every message key there is — the en dictionary IS the key set. */
export type MessageKey = keyof EnDict;

/** Keys whose value is count-dependent; `t` demands a `count` param for these. */
export type PluralKey = {
  [K in MessageKey]: EnDict[K] extends PluralForms ? K : never;
}[MessageKey];

export type SimpleKey = Exclude<MessageKey, PluralKey>;

/**
 * The contract every other dictionary must satisfy: same keys, same shape.
 * A missing key or a plural entry degraded to a plain string fails typecheck.
 */
export type Dictionary = {
  [K in MessageKey]: EnDict[K] extends PluralForms ? PluralForms : string;
};

export type TParams = Record<string, string | number>;

/**
 * Overloaded on purpose: a plural key without `count` is a compile error, so the
 * "forgot the count and shipped `{count} transaction`" bug cannot happen.
 */
export interface Translate {
  (key: SimpleKey, params?: TParams): string;
  (key: PluralKey, params: TParams & { count: number }): string;
}

const DICTS: Record<Lang, Dictionary> = { en, ru };

// Intl instances are expensive to construct; both caches are keyed by locale.
const pluralRulesCache = new Map<string, Intl.PluralRules>();
const numberFormatCache = new Map<string, Intl.NumberFormat>();

function pluralRules(locale: string): Intl.PluralRules {
  let rules = pluralRulesCache.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRulesCache.set(locale, rules);
  }
  return rules;
}

function numberFormat(locale: string): Intl.NumberFormat {
  let format = numberFormatCache.get(locale);
  if (!format) {
    format = new Intl.NumberFormat(locale);
    numberFormatCache.set(locale, format);
  }
  return format;
}

/**
 * The form for `count` in `locale`. `Intl.PluralRules` owns the rule (ru: 1/21/31
 * -> one, 2..4 -> few, 5..20 -> many, fractions -> other) — hand-written `n === 1`
 * branches are precisely what gets Russian wrong.
 *
 * `few`/`many` are optional in the shape (en has neither), so a language that does
 * not define the selected category falls back to `other`, never to `undefined`.
 */
function selectForm(forms: PluralForms, locale: string, count: number): string {
  const category = pluralRules(locale).select(count);
  switch (category) {
    case 'one':
      return forms.one;
    case 'few':
      return forms.few ?? forms.other;
    case 'many':
      return forms.many ?? forms.other;
    default:
      return forms.other;
  }
}

// `{name}` -> the param's value. An unknown placeholder is left AS WRITTEN: a
// visible `{name}` in the UI is a bug report; a silently empty sentence is not.
function interpolate(template: string, locale: string, params?: TParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    if (value === undefined) return match;
    return typeof value === 'number' ? numberFormat(locale).format(value) : value;
  });
}

/** The pure translator. `useT()` (context.ts) binds the `lang` argument. */
export function translate(lang: Lang, key: MessageKey, params?: TParams): string {
  const entry = DICTS[lang][key];
  const locale = localeFor(lang);
  const template =
    typeof entry === 'string'
      ? entry
      : selectForm(entry, locale, typeof params?.count === 'number' ? params.count : 0);
  return interpolate(template, locale, params);
}

/** `translate` with the language bound — what components receive as `t`. */
export function createTranslate(lang: Lang): Translate {
  const bound: Translate = (key: MessageKey, params?: TParams) =>
    translate(lang, key, params);
  return bound;
}
