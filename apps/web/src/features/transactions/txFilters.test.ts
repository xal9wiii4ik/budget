import { describe, expect, it } from 'vitest';

import {
  activeFilterCount,
  adoptsUrlSearchText,
  isNarrowed,
  parseTxFilters,
  showsDayGroups,
  txExportFilters,
  txListFilters,
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
      'month=2026-13&account=not-a-uuid&category=42&country=Belarus&sort=amount&range=month',
    );
    expect(selection).toEqual({
      month: MONTH,
      allTime: false,
      accountId: null,
      categoryId: null,
      q: null,
      country: null,
      sort: null,
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
  });

  it('is false for a wider set or a mere reordering', () => {
    expect(isNarrowed(parse('range=all'))).toBe(false);
    expect(isNarrowed(parse('sort=amount_desc'))).toBe(false);
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
