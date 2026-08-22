// The two languages this product speaks, as ONE type shared by every client
// (transaction-details-and-i18n S5). It lives in @budget/shared rather than in
// apps/web because the same value is a column on the server profile
// (`profiles.language`, architecture §6) and the mobile client reads the same
// dictionaries at unfreeze.
//
// `null` on the wire means "the user never chose" — that is NOT a third language
// and deliberately has no member here: the CLIENT resolves null to a language
// (cached choice, then browser locale) and only an explicit user choice is ever
// written back.
export type Lang = 'ru' | 'en';

/** Every supported language, in the order a picker should list them. */
export const LANGS = ['ru', 'en'] as const satisfies readonly Lang[];

/** Runtime narrow for values coming off the wire / off localStorage. */
export function isLang(value: unknown): value is Lang {
  return value === 'ru' || value === 'en';
}
