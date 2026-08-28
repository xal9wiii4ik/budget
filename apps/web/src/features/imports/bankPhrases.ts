// The bank's own words, in the user's language (credo-import).
//
// A Credo statement writes its Operation column and the opening of its
// Description in Georgian. Those are not user data and not free text: they are a
// CLOSED set of seven strings this bank's export produces, so the honest way to
// show them to a reader who does not read Georgian is a dictionary.
//
// The dictionary lives HERE and not in a table, on purpose (grooming decision,
// .tasks/credo-import/task.md): a translation depends on the language of the UI,
// which is a client fact — a DB table would have bought a contract change, a
// migration and an admin surface for seven frozen strings. The price of that
// choice is that a NEW phrase needs a release, which is exactly why
// `untranslated` below exists: it is the meter that says when the price got too
// high.
//
// What is translated and what is not:
//   - the four Operation values — by EXACT match, because that column is a
//     closed enumeration and a partial hit there would mean we misread it;
//   - the description PREFIXES — the bank's verb; everything after it (the
//     merchant, the "spent" pair, the date) is DATA and is copied through
//     verbatim. `გადახდა - YANDEX.EDA 56.10 BYN 01.08.2026` becomes
//     `Payment - YANDEX.EDA 56.10 BYN 01.08.2026`, never `Payment - Yandex Food`.
//
// Language-free by the house rule in the sense that matters: the module decides
// WHICH phrase it is and owns no sentences, taking the caller's bound `t` the way
// `periodicityLabel(template, t, locale)` does. Switching the UI language
// re-renders every row through the same tables.
import type { SimpleKey, Translate } from '../../i18n/t';

/** Georgian script, as the task defines it (U+10A0–U+10FF). */
const GEORGIAN = /[\u10A0-\u10FF]/u;

/** True when the string carries at least one Georgian letter. */
export function hasGeorgianScript(text: string): boolean {
  return GEORGIAN.test(text);
}

/**
 * Operation values — the whole column, matched WHOLE.
 *
 * Four entries because the real file has exactly four (task.md, read off the
 * sheet's sharedStrings). A fifth one showing up is news, and the badge is how
 * we hear about it.
 */
const EXACT_PHRASES: Readonly<Record<string, SimpleKey>> = {
  'საბარათე ოპერაცია': 'bankPhrase.cardOperation',
  'უნაღდო კონვერტაცია': 'bankPhrase.currencyConversion',
  'ბარათზე თანხის ჩარიცხვა': 'bankPhrase.cardTopUp',
  'სხვა და სხვა საკომისიო': 'bankPhrase.miscFee',
};

/**
 * Description openings — matched at the START of the line, tail untouched.
 *
 * `Currency Exchange` is Latin and already readable in English, but it is still
 * the bank's word rather than the user's, so it gets a Russian rendering like
 * the other two instead of being left half-translated on a Russian screen.
 *
 * Longest first: `startsWith` is order-sensitive, and a future prefix that
 * extends another one must win over its own opening.
 */
const PREFIX_TABLE = [
  ['გადახდა', 'bankPhrase.payment'],
  ['განაღდება', 'bankPhrase.cashWithdrawal'],
  ['Currency Exchange', 'bankPhrase.currencyExchange'],
] as const satisfies readonly (readonly [string, SimpleKey])[];

const PREFIX_PHRASES = [...PREFIX_TABLE].sort((a, b) => b[0].length - a[0].length);

export interface BankText {
  /** What to print: translated where we could, original everywhere else. */
  text: string;
  /**
   * True when what is left on screen still contains Georgian this build has no
   * copy for. The caller must show it — it is the signal that decides whether
   * this dictionary moves into the database, not decoration.
   */
  untranslated: boolean;
}

interface PhraseMatch {
  key: SimpleKey;
  /** Everything after the matched phrase — data, never translated. */
  rest: string;
}

/** Which dictionary entry (if any) this string opens with. */
function matchPhrase(source: string): PhraseMatch | null {
  const exact = EXACT_PHRASES[source];
  if (exact !== undefined) return { key: exact, rest: '' };

  for (const [prefix, key] of PREFIX_PHRASES) {
    if (!source.startsWith(prefix)) continue;
    const rest = source.slice(prefix.length);
    // The prefix must END where we say it does. Without this a longer Georgian
    // word that merely opens with a known one would be chopped in half and half
    // translated — a lie that reads like a parser bug.
    if (rest !== '' && hasGeorgianScript(rest.charAt(0))) continue;
    return { key, rest };
  }

  return null;
}

/**
 * Is there Georgian left in this string that the dictionary does not cover?
 *
 * Deliberately language-FREE: whether a phrase is missing from the tables is a
 * fact about this build, not about the reader, so the list-level note and the
 * per-row badge agree without either of them re-translating anything.
 */
export function bankTextUntranslated(text: string): boolean {
  const source = text.trim();
  if (source === '') return false;
  const match = matchPhrase(source);
  return hasGeorgianScript(match === null ? source : match.rest);
}

/**
 * The bank's string, ready to render.
 *
 * Never throws, never blanks: an unknown phrase comes back AS IT IS (a reader
 * who does read Georgian is better served by the original than by a placeholder)
 * plus the flag. A string with no Georgian in it and no known prefix is returned
 * untouched with `untranslated: false` — a Latin merchant line is not a gap in
 * the dictionary.
 */
export function translateBankText(text: string, t: Translate): BankText {
  const source = text.trim();
  if (source === '') return { text, untranslated: false };

  const match = matchPhrase(source);
  if (match === null) return { text, untranslated: hasGeorgianScript(source) };

  return {
    text: `${t(match.key)}${match.rest}`,
    untranslated: hasGeorgianScript(match.rest),
  };
}
