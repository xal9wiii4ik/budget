// CLDR plural categories for the two languages this product speaks, by hand.
//
// WHY THIS EXISTS ON MOBILE AND NOT ON WEB: web's `t.ts` asks
// `Intl.PluralRules` for the category. Hermes (Expo Go 57 / iOS 26.5) does not
// implement `Intl.PluralRules` at all — `new Intl.PluralRules(locale)` throws
// "undefined cannot be used as a constructor", which red-screened the accounts
// and categories tabs (mobile-catchup-1, D-1). `Intl.NumberFormat` and
// `Intl.Collator` DO exist there, so only this one seam is replaced; everything
// else still goes through Intl.
//
// The rules below are the CLDR plural rules for `en` and `ru`, which are short,
// stable and fully specified — a polyfill (or a dependency) for two languages
// would be more code and more risk than the twelve lines it replaces.
//
// ADDING A THIRD LANGUAGE MEANS EXTENDING THIS FILE: `Lang` gains a member,
// the switch below stops being exhaustive and typecheck fails until its CLDR
// rule is written here. That failure is the point — do not widen the fallback.
import type { Lang } from '@budget/shared';

export type PluralCategory = 'one' | 'few' | 'many' | 'other';

/**
 * The CLDR plural category of `count` in `lang`.
 *
 * Non-finite input and fractions fall to `other`, which is the category CLDR
 * itself assigns to non-integers in both languages (en: "1.5 accounts",
 * ru: "1,5 счёта"). The sign is irrelevant to the rule, so `Math.abs` first.
 */
export function pluralCategory(lang: Lang, count: number): PluralCategory {
  if (!Number.isFinite(count)) return 'other';
  const n = Math.abs(count);

  switch (lang) {
    // en: `i = 1 and v = 0` -> one; everything else -> other.
    case 'en':
      return Number.isInteger(n) && n === 1 ? 'one' : 'other';

    // ru: fractions -> other; then, on the integer,
    //   n % 10 == 1 and n % 100 != 11        -> one  (1, 21, 101)
    //   n % 10 in 2..4 and n % 100 not 12..14 -> few  (2, 3, 4, 22)
    //   otherwise                             -> many (5, 11, 14, 100)
    case 'ru': {
      if (!Number.isInteger(n)) return 'other';
      const mod10 = n % 10;
      const mod100 = n % 100;
      if (mod10 === 1 && mod100 !== 11) return 'one';
      if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'few';
      return 'many';
    }
  }
}
