// The "by meaning" search mode on /transactions (rag, Web A) — everything that
// can be decided without a DOM, in one tested module.
//
// LANGUAGE-FREE by the i18n rule: nothing here returns a sentence. `roundScore`
// returns a NUMBER and the component interpolates it through `t`, so the figure
// goes through `Intl.NumberFormat` of the chosen language ("0.83" / "0,83").
//
// NO MONEY is touched here either: the mode decides which rows to ask for and
// how to spell one score. The totals on screen are the server's `total` field.
//
// Dependency direction is deliberate: `txFilters.ts` imports `parseSearchMode`
// from here (runtime), and this module imports only TYPES from it. A runtime
// import back would be a cycle, which is why `txSearchFilters` takes the ALREADY
// BUILT list filters instead of the selection — see its own note.
import type { TxListFilters, TxSearchParams } from '../../data/queryKeys';
import type { TxFilterSelection } from './txFilters';

/**
 * How many hits one search asks for. ASK-1 CONFIRMED: the wire spells it `limit`
 * (amendment A6), accepts 1..50 and defaults to 20 — so 20 is what the first
 * request sends, and the ONE "show more" button re-asks with 50.
 *
 * There is no pagination on this route (the response has no offset grammar and
 * no `has_more`), which is exactly why the second value is a SECOND COMPLETE
 * ANSWER under its own cache key rather than a page appended to the first.
 */
export const TX_SEARCH_LIMIT = 20;
export const TX_SEARCH_LIMIT_MORE = 50;

/**
 * Which search the /transactions screen is running.
 *
 * `text` is the shipped `?q=` — an ILIKE over merchant and note, debounced,
 * paginated, sortable. `meaning` is `GET /transactions/search` — one embedding
 * call per committed phrase, ranked by closeness, top-k, no sort.
 *
 * They are two ENDPOINTS, not two renderings of one, so the mode is a URL
 * parameter (`?mode=meaning`) and not component state: a semantic search is then
 * shareable, survives F5 and is undone by the back button like every other
 * filter on this screen (web-qa Q-1, ruled).
 */
export type TxSearchMode = 'text' | 'meaning';

/** The default — and therefore the mode that travels as NO parameter at all. */
export const DEFAULT_TX_SEARCH_MODE: TxSearchMode = 'text';

/**
 * `?mode=` narrowed to the two modes, never a cast. Anything else — a typo, a
 * hand-typed value, a future mode this build does not know — is the TEXT mode:
 * the same rule the rest of this URL grammar follows (`parseTxFilters`), because
 * a junk parameter must not strand the user in a screen they did not ask for,
 * and the text list is the one that always works.
 *
 * `?mode=text` normalizes to the default too, so the plain list keeps exactly
 * one URL and one cache key however the parameter is spelled.
 */
export function parseSearchMode(value: string | null): TxSearchMode {
  return value === 'meaning' ? 'meaning' : DEFAULT_TX_SEARCH_MODE;
}

/**
 * Whether a semantic search is actually RUNNING — the mode is on AND there is a
 * committed phrase to run.
 *
 * The two halves are separate facts and the screen needs both: the mode alone
 * decides what the toolbar looks like (the toggle's state, the hidden sort, the
 * hidden Export), while this decides whether a request is made at all. Turning
 * the mode on must send nothing (web-qa TC-1): there is no phrase yet, and an
 * empty `q` would be a 422 `SEARCH_QUERY_BLANK` the screen has no field to show.
 */
export function searchModeActive(selection: TxFilterSelection): boolean {
  return selection.mode === 'meaning' && selection.q !== null;
}

/**
 * The search request / cache-key slice, or `null` when there is no phrase (the
 * `qk.fxConvert(params | null)` precedent: a stable key for the disabled state
 * instead of a fake parameter set).
 *
 * It takes the LIST's filters rather than the URL selection on purpose. The
 * server reuses `read_filters` minus `q`/`sort`/`goal_item_id` for this route
 * (D-R2) precisely so the filter semantics of the two endpoints cannot drift,
 * and this is the client's half of that: one window rule (`rangeBounds`, inside
 * `txListFilters`), transformed — never a second copy of it.
 *
 * Copied field by field rather than "everything except sort", the
 * `txExportFilters` discipline: a parameter added to the LIST is then absent
 * here until someone decides, in this one place, that /search declares it too.
 * That is why `sort` is STRUCTURALLY absent — sending the order a text list was
 * left in would be a 422 on a route that ranks by closeness — and why
 * `goal_item_id` is too (D-R2 drops it from the subset).
 */
export function txSearchFilters(
  filters: TxListFilters,
  limit: number,
): TxSearchParams | null {
  if (filters.q === undefined) return null;
  return {
    q: filters.q,
    ...(filters.from === undefined ? {} : { from: filters.from }),
    ...(filters.to === undefined ? {} : { to: filters.to }),
    ...(filters.category_id === undefined ? {} : { category_id: filters.category_id }),
    ...(filters.account_id === undefined ? {} : { account_id: filters.account_id }),
    ...(filters.kind === undefined ? {} : { kind: filters.kind }),
    ...(filters.country === undefined ? {} : { country: filters.country }),
    limit,
  };
}

/**
 * One hit's score, rounded to 2 decimal places and returned as a NUMBER.
 *
 * A number, not a string, because the component hands it to `t()` — which
 * interpolates through `Intl.NumberFormat` of the chosen language, so the badge
 * reads "близость 0,83" in Russian and "match 0.83" in English off ONE
 * dictionary entry. `toFixed` would hard-code the English decimal point (and is
 * the house's standing ban on formatting a figure inline).
 *
 * Two dp and nothing else: the raw cosine is 4 dp and lives in a 0.78–0.87 band
 * whose correct-vs-wrong margins are 0.006–0.03 (D-R3), so the figure is only
 * meaningful RELATIVE to its neighbours in the same list. That is why the list
 * carries one `tx.searchScoreNote` saying so, and why this is never a percentage
 * and never a bar: "84 %" claims a precision the number does not have, and a bar
 * invites comparing two different searches.
 */
export function roundScore(score: number): number {
  return Math.round(score * 100) / 100;
}
