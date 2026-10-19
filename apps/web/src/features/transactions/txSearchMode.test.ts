import { describe, expect, it } from 'vitest';

import { parseTxFilters, txListFilters, TX_LIST_LIMIT } from './txFilters';
import {
  parseSearchMode,
  roundScore,
  searchModeActive,
  txSearchFilters,
  TX_SEARCH_LIMIT,
} from './txSearchMode';

const MONTH = '2026-08';
const CATEGORY = '11111111-2222-3333-4444-555555555555';
const ACCOUNT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function parse(query: string) {
  return parseTxFilters(new URLSearchParams(query), MONTH);
}

/** The request slice the PAGE would build for this URL. */
function searchFilters(query: string, limit = TX_SEARCH_LIMIT) {
  return txSearchFilters(txListFilters(parse(query), TX_LIST_LIMIT), limit);
}

describe('parseSearchMode', () => {
  it('collapses every value but the one it knows to the word search', () => {
    // A typo, a future mode this build does not have, a missing parameter: all
    // of them are the search that always works, never a half-state.
    for (const value of ['semantic', 'MEANING', '', 'true', null]) {
      expect(parseSearchMode(value)).toBe('text');
    }
    expect(parseSearchMode('meaning')).toBe('meaning');
  });
});

describe('searchModeActive', () => {
  it('needs the mode AND a committed phrase', () => {
    // Turning the toggle on must cost nothing: with no phrase there is nothing
    // to embed, and an empty `q` would be a 422 the screen has no field to show.
    expect(searchModeActive(parse('mode=meaning'))).toBe(false);
    expect(searchModeActive(parse('mode=meaning&q=%20%20'))).toBe(false);
    expect(searchModeActive(parse('mode=meaning&q=car'))).toBe(true);
    // A phrase without the mode is the ordinary text search.
    expect(searchModeActive(parse('q=car'))).toBe(false);
  });
});

describe('txSearchFilters', () => {
  it('is null without a phrase, which is what disables the query', () => {
    expect(searchFilters('mode=meaning')).toBeNull();
  });

  it('carries the window, the filters and the limit, omitting what is unset', () => {
    expect(searchFilters('q=car')).toEqual({
      q: 'car',
      from: '2026-08-01',
      to: '2026-08-31',
      limit: TX_SEARCH_LIMIT,
    });

    expect(searchFilters(`q=car&category=${CATEGORY}&account=${ACCOUNT}&country=PL`)).toEqual({
      q: 'car',
      from: '2026-08-01',
      to: '2026-08-31',
      category_id: CATEGORY,
      account_id: ACCOUNT,
      country: 'PL',
      limit: TX_SEARCH_LIMIT,
    });

    // All-time drops the window exactly as the list does — the server takes both
    // ends as optional, so "the whole history" needs no parameter of its own.
    expect(searchFilters('range=all&q=car')).toEqual({ q: 'car', limit: TX_SEARCH_LIMIT });
  });

  it('never sends `sort`, even when the URL sets one', () => {
    // THE branch that would otherwise be a silent 422: /transactions/search has
    // no sort parameter at all (its results are ranked by closeness), while the
    // LIST keeps carrying one from the very same URL. The contrast is the test.
    const url = 'q=car&sort=amount_desc';
    expect(txListFilters(parse(url), TX_LIST_LIMIT).sort).toBe('amount_desc');
    expect(searchFilters(url)).not.toHaveProperty('sort');
  });

  it('puts "show more" under its own limit, not a page cursor', () => {
    // The route has no pagination: 50 hits are a SECOND complete answer, so the
    // limit is a key member and the two answers are two cache entries.
    expect(searchFilters('q=car', 50)?.limit).toBe(50);
  });
});

describe('roundScore', () => {
  it('rounds to two decimals and stays a NUMBER', () => {
    // A number, because the badge interpolates it through Intl.NumberFormat of
    // the chosen language ("0.83" in en, "0,83" in ru) — `toFixed` would freeze
    // the English decimal point into the sentence.
    expect(roundScore(0.8312)).toBe(0.83);
    expect(roundScore(0.8)).toBe(0.8);
    expect(roundScore(0.8789)).toBe(0.88);
  });
});
