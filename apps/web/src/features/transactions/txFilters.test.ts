import { describe, expect, it } from 'vitest';

import {
  activeFilterCount,
  adoptsUrlSearchText,
  isNarrowed,
  parseTxFilters,
  showsDayGroups,
  txExportFilters,
  txListFilters,
  txRangeMode,
} from './txFilters';

const MONTH = '2026-08';
const CATEGORY = '11111111-2222-3333-4444-555555555555';
const ACCOUNT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function parse(query: string) {
  return parseTxFilters(new URLSearchParams(query), MONTH);
}

describe('parseTxFilters', () => {
  it('drops every junk value instead of passing it to the server', () => {
    // Each of these would be a 422 the list has no field to show, or a slice the
    // user never asked for.
    const selection = parse(
      'month=2026-13&account=not-a-uuid&category=42&country=Belarus&sort=amount&range=month&mode=semantic',
    );
    expect(selection).toEqual({
      month: MONTH,
      allTime: false,
      from: null,
      to: null,
      accountId: null,
      categoryId: null,
      q: null,
      country: null,
      sort: null,
      mode: 'text',
    });
  });

  it('normalizes a shared link: lowercase country, whitespace-only q, explicit default sort', () => {
    const selection = parse('q=%20%20&country=by&sort=date_desc');
    expect(selection.q).toBeNull();
    expect(selection.country).toBe('BY');
    // The default order is expressed as "no sort", so an explicit one cannot
    // fork the default list into a second cache entry.
    expect(selection.sort).toBeNull();
  });

  it('keeps a real search and a real sort', () => {
    const selection = parse('q=%20coffee%20&sort=amount_asc&range=all');
    expect(selection.q).toBe('coffee');
    expect(selection.sort).toBe('amount_asc');
    expect(selection.allTime).toBe(true);
  });

  it('reports the search MODE, so a shared link opens the search it describes', () => {
    // The whole reason the mode lives in the URL: `?mode=meaning` is shareable,
    // F5 repeats the semantic search, and the back button leaves it whole.
    expect(parse('mode=meaning&q=car').mode).toBe('meaning');
    // The default is expressed as no parameter at all, so an explicit one cannot
    // fork the plain list into a second URL describing the same screen.
    expect(parse('mode=text&q=car').mode).toBe('text');
  });
});

describe('parseTxFilters — the custom period', () => {
  it('takes a complete, ordered pair', () => {
    expect(txRangeMode(parse('from=2026-07-04&to=2026-08-11'))).toEqual({
      kind: 'custom',
      from: '2026-07-04',
      to: '2026-08-11',
    });
  });

  it('falls back to the month for a half, impossible or inverted pair', () => {
    // Half a range, a date that does not exist (Feb 31 rolls forward in `new
    // Date`), and an end before the start: each would be a window the user did
    // not ask for, or a 422 the list has no field to show.
    for (const query of [
      'from=2026-07-04',
      'to=2026-08-11',
      'from=2026-02-31&to=2026-08-11',
      'from=yesterday&to=2026-08-11',
      'from=2026-08-11&to=2026-07-04',
    ]) {
      expect(txRangeMode(parse(query))).toEqual({ kind: 'month', month: MONTH });
    }
  });

  it('lets range=all win over a period, as it wins over everything else', () => {
    const selection = parse('range=all&from=2026-07-04&to=2026-08-11');
    expect(txRangeMode(selection)).toEqual({ kind: 'all' });
    expect(selection.from).toBeNull();
    expect(selection.to).toBeNull();
  });
});

describe('txListFilters', () => {
  it('omits every absent member, so the unfiltered month keeps its old cache key', () => {
    expect(txListFilters(parse(''), 200)).toEqual({
      from: '2026-08-01',
      to: '2026-08-31',
      limit: 200,
    });
  });

  it('carries only the filters that are set', () => {
    const filters = txListFilters(
      parse(`q=coffee&country=BY&sort=amount_desc&category=${CATEGORY}`),
      200,
    );
    expect(filters).toEqual({
      from: '2026-08-01',
      to: '2026-08-31',
      category_id: CATEGORY,
      q: 'coffee',
      country: 'BY',
      sort: 'amount_desc',
      limit: 200,
    });
  });

  it('drops the month window in all-time mode', () => {
    const filters = txListFilters(parse('range=all'), 200);
    expect(filters).toEqual({ limit: 200 });
  });

  it('puts a custom period in the SAME two members a month uses — no new key member', () => {
    // The whole point of the omit discipline: a period is another value of
    // from/to, so the unfiltered month above keeps byte-for-byte the cache key it
    // had before periods existed.
    expect(txListFilters(parse('from=2026-07-04&to=2026-08-11'), 200)).toEqual({
      from: '2026-07-04',
      to: '2026-08-11',
      limit: 200,
    });
  });
});

describe('txExportFilters', () => {
  it('passes q and country through but never sort (the endpoint has none)', () => {
    const filters = txListFilters(
      parse(`q=coffee&country=BY&sort=amount_desc&account=${ACCOUNT}`),
      200,
    );
    expect(txExportFilters(filters)).toEqual({
      from: '2026-08-01',
      to: '2026-08-31',
      account_id: ACCOUNT,
      q: 'coffee',
      country: 'BY',
    });
  });
});

describe('txExportFilters — the custom period', () => {
  it('exports exactly the window on screen, not the month around it', () => {
    const filters = txListFilters(parse(`from=2026-07-04&to=2026-08-11&country=BY`), 200);
    expect(txExportFilters(filters)).toEqual({
      from: '2026-07-04',
      to: '2026-08-11',
      country: 'BY',
    });
  });
});

describe('activeFilterCount', () => {
  it('counts the popover controls only — not the search box or the account picker', () => {
    expect(activeFilterCount(parse(`q=coffee&account=${ACCOUNT}`))).toBe(0);
    expect(activeFilterCount(parse(`category=${CATEGORY}&country=BY&sort=amount_asc`))).toBe(3);
  });
});

describe('isNarrowed', () => {
  it('is true for every filter that holds rows back', () => {
    expect(isNarrowed(parse(`account=${ACCOUNT}`))).toBe(true);
    expect(isNarrowed(parse(`category=${CATEGORY}`))).toBe(true);
    expect(isNarrowed(parse('q=coffee'))).toBe(true);
    expect(isNarrowed(parse('country=BY'))).toBe(true);
    // A search BY MEANING narrows too, so both deadline widgets stay hidden:
    // their rows (templates, plan items, deposits, debts) are not even in the
    // indexed population, so they could not honestly answer the phrase.
    expect(isNarrowed(parse('mode=meaning&q=everything%20about%20the%20car'))).toBe(true);
  });

  it('is false for a wider set, a mere reordering or another period', () => {
    expect(isNarrowed(parse('range=all'))).toBe(false);
    expect(isNarrowed(parse('sort=amount_desc'))).toBe(false);
    // A custom period is a range MODE, like the month: the upcoming-charges
    // widget answers "the next 30 days" under it exactly as it does under a month.
    expect(isNarrowed(parse('from=2026-07-04&to=2026-08-11'))).toBe(false);
  });
});

describe('showsDayGroups', () => {
  it('groups the date orders and flattens the amount orders', () => {
    expect(showsDayGroups(null)).toBe(true);
    expect(showsDayGroups('date_asc')).toBe(true);
    expect(showsDayGroups('amount_desc')).toBe(false);
    expect(showsDayGroups('amount_asc')).toBe(false);
  });
});

describe('adoptsUrlSearchText', () => {
  it('keeps what is being typed when the URL only echoes its own trimmed commit', () => {
    // "coffee " committed as "coffee": adopting it would delete the space the
    // user just typed.
    expect(adoptsUrlSearchText('coffee', 'coffee ')).toBe(false);
  });

  it('adopts a genuinely external change (back button, cleared filter)', () => {
    expect(adoptsUrlSearchText('', 'coffee')).toBe(true);
    expect(adoptsUrlSearchText('rent', 'coffee')).toBe(true);
  });
});
