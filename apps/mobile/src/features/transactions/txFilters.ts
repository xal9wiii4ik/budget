// The transaction list's filter grammar (catch-up 3, line A) — the mobile port of
// web's features/transactions/txFilters.ts.
//
// Everything about WHICH rows to ask for lives here, and nothing about how they
// look. It is pure and platform-free, so it is testable under Node like the rest of
// this client's decision modules.
//
// WHAT IS THE SAME AS WEB, deliberately and for the same reasons: the sort values,
// the "default order is never sent" rule, the page size, the custom-range
// validation, the omit-don't-undefined key rules, `isNarrowed` and `showsDayGroups`.
// Those are cache-key and honesty rules; two apps disagreeing about them would mean
// two different answers to "what am I looking at".
//
// WHAT IS GONE: everything URL-shaped. Web parses `?month=&range=&q=…` because its
// URL is the single source of truth and a hand-typed parameter must collapse to "no
// filter". A phone screen has no URL — the selection below IS component state, only
// ever written by the controls on screen — so `parseTxFilters`, `isValidRangeDate`'s
// URL duty and `adoptsUrlSearchText` have no mobile counterpart. The date validation
// stays, because the custom-range form can still hold an incomplete or inverted pair
// before it is applied.
import { monthBounds } from '@budget/shared';

import type { TxListFilters, TxSort } from '../../data/queryKeys';

/**
 * The four sort orders the server accepts, as VALUES (the type comes from the
 * generated client — data/queryKeys.ts). `satisfies` proves every literal here is
 * one the contract knows. The reverse (nothing missing from this list) is proved
 * where it matters: the sheet's `Record<TxSort, SimpleKey>` of option labels and the
 * exhaustive switch in `showsDayGroups` both fail typecheck the day the server grows
 * a fifth order.
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
 * Which window the list is showing, as ONE value — the three modes are mutually
 * exclusive and every consumer (the toolbar, the summary, the empty state, the
 * cache key) must agree on which one is on.
 */
export type TxRangeMode =
  | { kind: 'month'; month: string }
  | { kind: 'all' }
  | { kind: 'custom'; from: string; to: string };

/**
 * The window a screen with a period control (but no all-time mode) can show — the
 * category screen's, whose headline total comes from `/stats/summary`, a grammar
 * with no all-time unit.
 *
 * Derived from `TxRangeMode` rather than restated, so a fourth range mode lands in
 * this union too and fails the exhaustive switches instead of being ignored.
 */
export type TxWindowPeriod = Exclude<TxRangeMode, { kind: 'all' }>;

/**
 * Everything the transactions screen is filtering by, as one value. Unlike web's
 * `TxFilterSelection` this is plain component state: `null` means "no filter", and
 * nothing here was ever parsed from an untrusted string.
 */
export interface TxSelection {
  mode: TxRangeMode;
  accountId: string | null;
  categoryId: string | null;
  /** The trimmed, DEBOUNCED search text, or null when nothing is being searched. */
  q: string | null;
  /** ISO 3166-1 alpha-2, uppercase — the shape the server validates. */
  country: string | null;
  /** null = the default order, which is sent as NO parameter. */
  sort: TxSort | null;
}

/**
 * How many rows one page of a transaction list asks for: the whole month slice in
 * one request, "load more" only if the total exceeds it.
 *
 * It lives HERE, next to the rest of the key grammar, because `limit` is a member of
 * `TxListFilters` and therefore of the cache key: the transactions tab, the category
 * screen and the transaction form's edit-row lookup all describe the same slices,
 * and two different values would silently split each into two cache entries that
 * fetch the same rows twice. `data/transactions` re-exports it under its shipped
 * name `MONTH_LIMIT`, so this file stays free of anything that would drag React
 * Query — and with it react-native — into the test graph.
 */
export const TX_LIST_LIMIT = 200;

function isTxSort(value: string | null): value is TxSort {
  return value !== null && (TX_SORTS as readonly string[]).includes(value);
}

/**
 * A sort value from a control, narrowed to the contract's union — never a cast.
 * `null` for anything the server would not accept AND for the default order, which
 * is expressed by sending nothing at all: picking "Newest first" back must return to
 * exactly the cache key of an untouched list, not mint a second entry for the same
 * rows.
 */
export function toTxSort(value: string | null): TxSort | null {
  return isTxSort(value) && value !== DEFAULT_TX_SORT ? value : null;
}

// The wire format of a date, `YYYY-MM-DD`.
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A real calendar date in the wire format. The round-trip rejects "2026-02-31",
 * which `new Date` silently rolls forward to March 3. The native date picker can
 * only produce real dates, so this is belt-and-braces — but `customRange` is also
 * the gate on an EMPTY draft, and the server would answer a malformed pair with a
 * 422 this list has no field to show. Local midnight, never an ISO parse (the TZ
 * rule in @budget/shared/dates).
 */
export function isValidRangeDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const local = new Date(y, m - 1, d);
  return local.getFullYear() === y && local.getMonth() === m - 1 && local.getDate() === d;
}

/**
 * The custom period, or null when the draft does not describe one.
 *
 * Both ends are REQUIRED (a one-sided range is not this scope) and `from` must not
 * be after `to`: an inverted pair is a typo, and the server would answer it with an
 * empty list that looks exactly like "you have nothing here".
 *
 * String comparison is the right one for `YYYY-MM-DD` — zero-padded fixed-width
 * fields sort lexicographically the way they sort chronologically, so no Date is
 * built and no timezone is involved.
 */
export function customRange(
  from: string | null,
  to: string | null,
): { from: string; to: string } | null {
  if (from === null || to === null) return null;
  if (!isValidRangeDate(from) || !isValidRangeDate(to)) return null;
  return from <= to ? { from, to } : null;
}

/**
 * The window, as the `from`/`to` the request (and therefore the cache key) carry.
 *
 * A custom period writes the SAME two fields a month does — no key member of its own
 * — so an unfiltered month keeps byte-for-byte the key it had before custom periods
 * existed, and all-time omits both (the server takes them as optional, so "the whole
 * history" needs no endpoint of its own).
 */
export function rangeBounds(
  mode: TxRangeMode,
): { from: string; to: string } | Record<string, never> {
  switch (mode.kind) {
    case 'all':
      return {};
    case 'custom':
      return { from: mode.from, to: mode.to };
    case 'month':
      return monthBounds(mode.month);
  }
}

/**
 * The query-key / request slice. Every member is OMITTED, not set to undefined, when
 * nothing is filtered: the unfiltered month keeps exactly the cache key it had
 * before these filters existed — the very key the transaction form rebuilds to
 * locate its edit row — and every filtered variant is its own entry.
 */
export function txListFilters(selection: TxSelection, limit: number): TxListFilters {
  return {
    ...rangeBounds(selection.mode),
    ...(selection.categoryId === null ? {} : { category_id: selection.categoryId }),
    ...(selection.accountId === null ? {} : { account_id: selection.accountId }),
    ...(selection.q === null ? {} : { q: selection.q }),
    ...(selection.country === null ? {} : { country: selection.country }),
    ...(selection.sort === null ? {} : { sort: selection.sort }),
    limit,
  };
}

/**
 * The list slice for ONE category over a window — byte-for-byte what
 * `txListFilters` builds on the transactions tab for the same category and the same
 * period, so the category screen and the tab read ONE cache entry instead of
 * fetching the same rows twice.
 *
 * It goes through `txListFilters` rather than assembling its own object precisely so
 * that identity cannot drift: a filter added to the tab is either in both or in
 * neither.
 */
export function categoryListFilters(
  categoryId: string,
  period: TxWindowPeriod,
  limit: number,
): TxListFilters {
  return txListFilters(
    { mode: period, accountId: null, categoryId, q: null, country: null, sort: null },
    limit,
  );
}

/**
 * How many of the SHEET's own controls are set (category, country, sort) — the
 * button's badge. The search box and the account filter live in the toolbar with
 * their own visible state, so counting them here would badge a filter the user is
 * already looking at.
 */
export function activeFilterCount(selection: TxSelection): number {
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
 * Drives the visibility of the /transactions widgets: they read TEMPLATES and PLAN
 * ITEMS, which carry no note, no country, no account and no category, so they cannot
 * honestly answer a search or a country filter, and a half-filtered widget lies.
 * Hiding them on any narrowed set is the one consistent rule.
 *
 * Deliberately NOT narrowing: all-time (a WIDER set), `sort` (the same set in
 * another order) and the custom period. The period is a MODE of the same class as
 * the month — a widget answers "the next 30 days" regardless of which window is on
 * screen — so a date range must not hide it either.
 */
export function isNarrowed(selection: TxSelection): boolean {
  return (
    selection.accountId !== null ||
    selection.categoryId !== null ||
    selection.q !== null ||
    selection.country !== null
  );
}

/**
 * Whether the list renders day headers. Grouping by day describes a list ordered BY
 * day; under an amount sort the groups would each hold one or two rows in no
 * particular date order, which reads as broken rather than as grouped — so those two
 * orders render a flat list instead, and each row states its own date.
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
