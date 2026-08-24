import { COUNTRY_CODE_PATTERN, monthBounds } from '@budget/shared';

import type { TxListFilters, TxSort } from '../../data/queryKeys';
import type { ExportFilters } from '../../data/transactions';

// A month URL parameter, or nothing: "2026-08".
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
// `?account=` / `?category=` are URL parameters anyone can type. The server
// declares both filters as UUIDs, so a junk value would come back as a 422 the
// list has no field to show it on; an unparseable id is treated as no filter.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The four sort orders the server accepts, as VALUES (the type comes from the
 * generated client — data/queryKeys.ts). `satisfies` proves every literal here is
 * one the contract knows. The reverse (nothing missing from this list) is proved
 * where it matters: the popover's `Record<TxSort, MessageKey>` of option labels
 * and the exhaustive switch in `showsDayGroups` both fail typecheck the day the
 * server grows a fifth order.
 */
export const TX_SORTS = [
  'date_desc',
  'date_asc',
  'amount_desc',
  'amount_asc',
] as const satisfies readonly TxSort[];

/** The server's default order. It is NEVER sent — omitted means exactly this. */
export const DEFAULT_TX_SORT: TxSort = 'date_desc';

/**
 * Everything the /transactions URL says about WHAT to show, already validated.
 * `null` means "no filter", not "unknown": every junk value in the URL collapses
 * to it, so a hand-typed parameter can never strand the user in a slice they did
 * not ask for nor produce a 422 the list has no field to show.
 */
export interface TxFilterSelection {
  month: string;
  allTime: boolean;
  accountId: string | null;
  categoryId: string | null;
  /** The trimmed search text, or null when nothing is being searched for. */
  q: string | null;
  /** ISO 3166-1 alpha-2, uppercase — the shape the server validates. */
  country: string | null;
  /** null = the default order, which is sent as NO parameter. */
  sort: TxSort | null;
}

/**
 * Read the whole filter set out of the URL. `fallbackMonth` is the current month
 * (passed in rather than read here, so this stays a pure function of its input).
 */
export function parseTxFilters(
  params: URLSearchParams,
  fallbackMonth: string,
): TxFilterSelection {
  const month = params.get('month');
  const account = params.get('account');
  const category = params.get('category');
  const q = params.get('q')?.trim() ?? '';
  // Uppercased on the way in, so a shared link with `?country=by` filters exactly
  // like the one the picker writes instead of 422-ing on the server's `^[A-Z]{2}$`.
  const country = params.get('country')?.trim().toUpperCase() ?? '';
  const sort = params.get('sort');

  return {
    month: month !== null && MONTH_PATTERN.test(month) ? month : fallbackMonth,
    // Any other value of `range` is the month mode, so a typo cannot strand the
    // user in a window they did not ask for.
    allTime: params.get('range') === 'all',
    accountId: account !== null && UUID_PATTERN.test(account) ? account : null,
    categoryId: category !== null && UUID_PATTERN.test(category) ? category : null,
    q: q === '' ? null : q,
    country: COUNTRY_CODE_PATTERN.test(country) ? country : null,
    // An explicit `?sort=date_desc` normalizes to null: it IS the default, and
    // keeping it would give the default list a second cache key describing the
    // same rows.
    sort: toTxSort(sort),
  };
}

function isTxSort(value: string | null): value is TxSort {
  return value !== null && (TX_SORTS as readonly string[]).includes(value);
}

/**
 * A sort value from a <select> or the URL, narrowed to the contract's union —
 * never a cast. `null` for anything the server would not accept AND for the
 * default order, which is expressed by sending nothing at all.
 */
export function toTxSort(value: string | null): TxSort | null {
  return isTxSort(value) && value !== DEFAULT_TX_SORT ? value : null;
}

/**
 * The query-key / request slice. Every member is OMITTED, not set to undefined,
 * when nothing is filtered: the unfiltered month keeps exactly the cache key it
 * had before these filters existed, and every filtered variant is its own entry
 * (data/queryKeys.ts). In all-time mode from/to leave too — the server takes both
 * as optional, so "the whole history" needs no endpoint of its own.
 */
export function txListFilters(
  selection: TxFilterSelection,
  limit: number,
): TxListFilters {
  return {
    ...(selection.allTime ? {} : monthBounds(selection.month)),
    ...(selection.categoryId === null ? {} : { category_id: selection.categoryId }),
    ...(selection.accountId === null ? {} : { account_id: selection.accountId }),
    ...(selection.q === null ? {} : { q: selection.q }),
    ...(selection.country === null ? {} : { country: selection.country }),
    ...(selection.sort === null ? {} : { sort: selection.sort }),
    limit,
  };
}

/**
 * The export takes the list's filters verbatim, minus the pagination pair — an
 * export is the whole matching set, not the page on screen (D13) — and minus
 * `sort`: GET /transactions/export has no such parameter, because a CSV is
 * documented as OLDEST-FIRST regardless of how the screen is ordered.
 */
export function txExportFilters(filters: TxListFilters): ExportFilters {
  // Copied field by field rather than "everything except limit/sort": a
  // parameter added to the LIST is then absent from the export until someone
  // decides, in this one line, that /export accepts it too — the default is
  // never to send the endpoint something it does not declare.
  return {
    ...(filters.from === undefined ? {} : { from: filters.from }),
    ...(filters.to === undefined ? {} : { to: filters.to }),
    ...(filters.category_id === undefined ? {} : { category_id: filters.category_id }),
    ...(filters.kind === undefined ? {} : { kind: filters.kind }),
    ...(filters.account_id === undefined ? {} : { account_id: filters.account_id }),
    ...(filters.q === undefined ? {} : { q: filters.q }),
    ...(filters.country === undefined ? {} : { country: filters.country }),
  };
}

/**
 * How many of the POPOVER's own controls are set (category, country, sort). The
 * search box and the account picker live in the toolbar with their own visible
 * state, so counting them here would badge a filter the user is already looking at.
 */
export function activeFilterCount(selection: TxFilterSelection): number {
  return (
    (selection.categoryId === null ? 0 : 1) +
    (selection.country === null ? 0 : 1) +
    (selection.sort === null ? 0 : 1)
  );
}

/**
 * Whether the list shows a NARROWED set of transactions — i.e. some rows the
 * unfiltered list would show are being held back.
 *
 * Drives the visibility of the upcoming-charges widget (senior-lead decision,
 * S1 tail): that widget reads TEMPLATES, which carry no note and no country, so
 * it cannot honestly answer a search or a country filter, and a half-filtered
 * widget lies. Hiding it on any narrowed set is the one consistent rule — and it
 * also covers the account filter, which it used to ignore.
 *
 * Deliberately NOT narrowing: `range=all` (a WIDER set) and `sort` (the same set
 * in another order).
 */
export function isNarrowed(selection: TxFilterSelection): boolean {
  return (
    selection.accountId !== null ||
    selection.categoryId !== null ||
    selection.q !== null ||
    selection.country !== null
  );
}

/**
 * Whether the list renders day headers. Grouping by day describes a list ordered
 * BY day; under an amount sort the groups would each hold one or two rows in no
 * particular date order, which reads as broken rather than as grouped — so those
 * two orders render a flat list instead.
 */
export function showsDayGroups(sort: TxSort | null): boolean {
  switch (sort ?? DEFAULT_TX_SORT) {
    case 'date_desc':
    case 'date_asc':
      return true;
    case 'amount_desc':
    case 'amount_asc':
      return false;
  }
}

/**
 * Whether a `q` that changed in the URL should overwrite what is currently typed
 * in the search box.
 *
 * The box is debounced, so its own commit comes back as a prop a moment later:
 * adopting that would delete a character typed in the meantime, and — since the
 * committed value is TRIMMED — would eat the space the user just typed at the
 * end of a word. Anything else (the back button, a shared link, the chip's
 * clear button) is a real external change and does win over the typed text.
 */
export function adoptsUrlSearchText(urlValue: string, typed: string): boolean {
  return urlValue !== typed.trim();
}
